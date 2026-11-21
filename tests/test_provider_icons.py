"""供应商自定义图标（PLAN §8，I1）：校验与重新编码、按内容寻址落盘、读取接口、清理宽限期。"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import pytest
import requests
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import BaseModel, create_model

from character_workflow.lib import data_root, keys, provider_icons
from tests.fake_http_vendor import FakeVendor
from tests.local_client import LocalTestClient
from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app


def _image(fmt: str, size=(40, 20), color=(200, 30, 30, 255), **save) -> bytes:
    out = BytesIO()
    image = Image.new("RGBA", size, color)
    if fmt == "JPEG":
        image = image.convert("RGB")
    image.save(out, fmt, **save)
    return out.getvalue()


def _decoded(png: bytes) -> Image.Image:
    image = Image.open(BytesIO(png))
    image.load()
    return image


@pytest.fixture
def client(isolated_data_root):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app())


# --- normalize：只按文件头认格式，先查尺寸再解码，一律重新编码 -----------------------------

@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP", "GIF", "ICO"])
def test_each_supported_format_becomes_a_128_square_png(fmt):
    png = provider_icons.normalize(_image(fmt))
    image = _decoded(png)
    assert (image.format, image.size, image.mode) == ("PNG", (128, 128), "RGBA")
    # 等比缩放进透明画布：40×20 → 128×64，上下留透明边。
    assert image.getpixel((64, 64))[3] == 255 and image.getpixel((64, 5))[3] == 0
    assert "exif" not in image.info and "icc_profile" not in image.info


def test_metadata_and_trailing_bytes_are_not_kept():
    exif = Image.Exif()
    exif[0x010F] = "secret-camera"
    raw = _image("JPEG", exif=exif.tobytes()) + b"<script>alert(1)</script>"
    png = provider_icons.normalize(raw)
    assert b"secret-camera" not in png and b"<script>" not in png
    assert "exif" not in _decoded(png).info


def test_animated_gif_uses_the_first_frame():
    frames = [Image.new("RGB", (16, 16), color) for color in ((255, 0, 0), (0, 0, 255))]
    out = BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:])
    pixel = _decoded(provider_icons.normalize(out.getvalue())).getpixel((64, 64))
    assert pixel[0] > 200 and pixel[2] < 50


def test_ico_uses_the_largest_image():
    out = BytesIO()
    Image.new("RGBA", (64, 64), (0, 0, 255, 255)).save(out, "ICO", sizes=[(16, 16), (64, 64)])
    raw = out.getvalue()
    assert provider_icons._ico_largest(raw) == (64, 64)
    assert _decoded(provider_icons.normalize(raw)).getpixel((64, 64))[2] > 200


@pytest.mark.parametrize("raw", [
    b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    b"<!doctype html><html><body>not an image</body></html>",
    b"",
])
def test_svg_html_and_unknown_content_are_rejected(raw):
    """normalize 只拿到字节：SVG 改名 .png、Content-Type 写 image/png 都进不来。"""
    with pytest.raises(provider_icons.IconRejected, match="^不支持这种图片格式$"):
        provider_icons.normalize(raw)


def test_truncated_png_is_unreadable():
    raw = _image("PNG", size=(64, 64))
    with pytest.raises(provider_icons.IconRejected, match="无法识别"):
        provider_icons.normalize(raw[:60])


def test_over_one_megabyte_is_rejected():
    with pytest.raises(provider_icons.IconRejected, match="^图片超过 1 MB$"):
        provider_icons.normalize(_image("PNG")[:8] + b"\x00" * (provider_icons.MAX_BYTES + 1))


def _forbid_decoding(monkeypatch):
    """之后的解码一律失败：被测的拒绝必须发生在解码之前（ImageFile.load 才是真正的解码入口）。

    要在造好测试图之后再调用：保存图片本身也会走 load。"""
    from PIL import ImageFile

    monkeypatch.setattr(ImageFile.ImageFile, "load", lambda self: pytest.fail("不应解码"))
    monkeypatch.setattr(Image.Image, "load", lambda self: pytest.fail("不应解码"))


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP", "GIF"])
def test_oversized_images_are_rejected_from_the_header(fmt, monkeypatch):
    raw = _image(fmt, size=(2049, 16), color=(0, 0, 0, 255))
    _forbid_decoding(monkeypatch)
    with pytest.raises(provider_icons.IconRejected, match="^图片尺寸超过 2048×2048$"):
        provider_icons.normalize(raw)


def test_decompression_bomb_is_rejected_from_the_header(monkeypatch):
    """小文件声明 4000×4001：只读头部就拒绝，不进解码。"""
    raw = _image("PNG", size=(4000, 4001), color=(0, 0, 0, 0))
    assert len(raw) < 200_000
    _forbid_decoding(monkeypatch)
    with pytest.raises(provider_icons.IconRejected, match="尺寸超过"):
        provider_icons.normalize(raw)


def test_extreme_aspect_ratio_says_so():
    with pytest.raises(provider_icons.IconRejected, match="^图片长宽比过大$"):
        provider_icons.normalize(_image("PNG", size=(2048, 4)))
    assert _decoded(provider_icons.normalize(_image("PNG", size=(2048, 8)))).size == (128, 128)


def _ico(entry_body: bytes) -> bytes:
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(entry_body), 6 + 16)
    return header + entry + entry_body


def test_ico_with_a_huge_embedded_png_is_rejected_before_pillow_opens_it(monkeypatch):
    """ICO 目录项宽高只有一个字节；内嵌 PNG 的真实尺寸要读它自己的头。Pillow 打开 ICO 就会解码，所以连 open 都不能走到。"""
    monkeypatch.setattr(provider_icons.Image, "open", lambda *a, **k: pytest.fail("不应打开"))
    with pytest.raises(provider_icons.IconRejected, match="尺寸超过"):
        provider_icons.normalize(_ico(_image("PNG", size=(5000, 5000), color=(0, 0, 0, 0))))


def test_ico_with_a_huge_dib_entry_is_rejected_before_pillow_opens_it(monkeypatch):
    """DIB（BMP）条目：真实宽高在 BITMAPINFOHEADER 里，高度是两倍（含掩码）。"""
    monkeypatch.setattr(provider_icons.Image, "open", lambda *a, **k: pytest.fail("不应打开"))
    dib = struct.pack("<IiiHHIIiiII", 40, 3000, 6000, 1, 32, 0, 0, 0, 0, 0, 0) + b"\x00" * 64
    with pytest.raises(provider_icons.IconRejected, match="尺寸超过"):
        provider_icons.normalize(_ico(dib))
    small = struct.pack("<IiiHHIIiiII", 40, 4000, 2, 1, 32, 0, 0, 0, 0, 0, 0)
    with pytest.raises(provider_icons.IconRejected, match="尺寸超过"):
        provider_icons.normalize(_ico(small))  # 宽 4000、高 1：同样按 DIB 头拦下


def test_decoder_is_the_one_the_header_names(monkeypatch):
    """文件头说是哪种格式，Pillow 就只能用那一个解码器（formats=[...]），不让它按内容另猜。"""
    seen = []
    real_open = provider_icons.Image.open

    def spy(fp, *args, **kwargs):
        seen.append(kwargs.get("formats"))
        return real_open(fp, *args, **kwargs)

    monkeypatch.setattr(provider_icons.Image, "open", spy)
    for fmt in ("PNG", "JPEG", "WEBP", "GIF", "ICO"):
        provider_icons.normalize(_image(fmt))
    assert seen == [["PNG"], ["JPEG"], ["WEBP"], ["GIF"], ["ICO"]]
    with pytest.raises(provider_icons.IconRejected):
        provider_icons.normalize(b"\x89PNG\r\n\x1a\n" + _image("GIF"))


# --- 落盘、读取接口 ------------------------------------------------------------------

def test_store_is_content_addressed_and_deduplicated(isolated_data_root):
    first = provider_icons.store(_image("PNG"))
    assert provider_icons.store(_image("PNG")) == first and first.startswith("file:")
    sha = first[5:]
    path = provider_icons.icons_dir() / f"{sha}.png"
    assert path.parent == data_root.config_dir() / "provider-icons"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == sha
    assert [p.name for p in path.parent.iterdir()] == [f"{sha}.png"]


def test_get_serves_the_png_with_safe_headers(client):
    sha = provider_icons.store(_image("PNG"))[5:]
    response = client.get(f"/api/provider-icons/{sha}")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "immutable" in response.headers["cache-control"]
    assert _decoded(response.content).size == (128, 128)


@pytest.mark.parametrize("sha", [
    "0" * 64,                    # 合规但不存在
    "A" * 64,                    # 大写十六进制
    "0" * 63,
])
def test_get_unknown_or_malformed_sha_is_404(client, sha):
    assert client.get(f"/api/provider-icons/{sha}").status_code == 404


@pytest.mark.parametrize("path", ["..%2F..%2Fkeys.json", "%2E%2E%2Fkeys", "../keys.json"])
def test_path_traversal_never_reads_other_files(client, path):
    """解码后是多段路径，能力表就不放行（403）；到了路由也只认 64 位十六进制。"""
    data_root.config_dir().mkdir(parents=True, exist_ok=True)
    (data_root.config_dir() / "keys.json").write_text('{"secret": "x"}')
    response = client.get(f"/api/provider-icons/{path}")
    assert response.status_code in {403, 404} and b"secret" not in response.content


def test_get_needs_the_local_session(isolated_data_root):
    sha = provider_icons.store(_image("PNG"))[5:]
    anonymous = TestClient(build_app(), base_url="http://127.0.0.1:5174")
    anonymous.headers.update({"Origin": "http://127.0.0.1:5174", "Sec-Fetch-Site": "same-origin"})
    assert anonymous.get(f"/api/provider-icons/{sha}").status_code == 401


def test_gateway_port_does_not_serve_icons(isolated_data_root):
    from character_workflow.lib import gateway_keys

    sha = provider_icons.store(_image("PNG"))[5:]
    _, token = gateway_keys.create_key("成员")
    gateway = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    assert gateway.get(f"/api/provider-icons/{sha}").status_code == 404


# --- KeySpec.icon：只在写入边界校验 ------------------------------------------------------

def _custom(**extra):
    return {"alias": "relay", "provider": "custom", "base_url": "https://relay.example/v1",
            "access_key": "k", "modalities": ["llm"], **extra}


def test_icon_is_saved_patched_and_reset(client):
    icon = provider_icons.store(_image("PNG"))
    assert client.post("/api/keys", json=_custom(icon=icon)).status_code == 201
    assert keys.find_by_alias("relay").icon == icon
    assert client.get("/api/keys").json()["keys"][0]["icon"] == icon
    assert client.patch("/api/keys/relay", json={"icon": "brand:deepseek"}).status_code == 200
    assert keys.find_by_alias("relay").icon == "brand:deepseek"
    assert client.patch("/api/keys/relay", json={"notes": "x"}).status_code == 200
    assert keys.find_by_alias("relay").icon == "brand:deepseek"  # 不传不改
    assert client.patch("/api/keys/relay", json={"icon": None}).status_code == 200
    assert keys.find_by_alias("relay").icon is None
    assert "icon" not in json.loads(data_root.keys_file().read_text())["keys"][0]


@pytest.mark.parametrize(("icon", "detail"), [
    ("file:" + "0" * 64, "不存在"),
    ("file:../keys.json", "格式无效"),
    ("brand:Deep Seek", "格式无效"),
    ("https://example.com/x.png", "格式无效"),
    ("data:image/png;base64,AAAA", "格式无效"),
])
def test_invalid_icon_is_rejected_at_write(client, icon, detail):
    response = client.post("/api/keys", json=_custom(icon=icon))
    assert response.status_code == 422 and detail in response.json()["detail"]
    assert client.post("/api/keys", json=_custom()).status_code == 201
    patched = client.patch("/api/keys/relay", json={"icon": icon})
    assert patched.status_code == 422 and detail in patched.json()["detail"]
    assert keys.find_by_alias("relay").icon is None


def test_dangling_icon_never_breaks_the_key_list(client):
    """手改配置、把 keys.json 拷给同事（不带图标文件）、清理竞态：读取 404，列表照常。"""
    keys.add_key(keys.KeySpec(alias="relay", provider="custom", access_key="k", created_at="t",
                              icon="file:" + "a" * 64))
    listing = client.get("/api/keys")
    assert listing.status_code == 200 and listing.json()["keys"][0]["icon"] == "file:" + "a" * 64
    assert client.get("/api/provider-icons/" + "a" * 64).status_code == 404
    assert client.patch("/api/keys/relay", json={"notes": "still works"}).status_code == 200


def test_older_readers_ignore_the_icon_field(isolated_data_root):
    """ADR-0030：带 icon 的 keys.json 交给不认识这个字段的旧版模型类，照样读得出。"""
    keys.add_key(keys.KeySpec(alias="relay", provider="custom", access_key="k", created_at="t",
                              icon="brand:deepseek"))
    raw = json.loads(data_root.keys_file().read_text())["keys"][0]
    assert raw["icon"] == "brand:deepseek"
    fields = {name: (info.annotation, info) for name, info in keys.KeySpec.model_fields.items()
              if name != "icon"}
    old_key_spec = create_model("OldKeySpec", __base__=BaseModel, **fields)
    old = old_key_spec.model_validate(raw)
    assert old.alias == "relay" and not hasattr(old, "icon")


# --- 清理：未引用且过了宽限期的才删 ------------------------------------------------------

def _age(icon: str, seconds: float) -> None:
    path = provider_icons.file_path(icon[5:])
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def test_upload_then_another_key_write_then_save_keeps_the_icon(client):
    icon = provider_icons.store(_image("PNG"))
    # 第一把 KEY 的表单还没保存；另一把 KEY 写入触发清理。
    assert client.post("/api/keys", json={**_custom(), "alias": "other"}).status_code == 201
    assert provider_icons.file_path(icon[5:]) is not None
    assert client.post("/api/keys", json=_custom(icon=icon)).status_code == 201
    assert client.get(f"/api/provider-icons/{icon[5:]}").status_code == 200


def test_unreferenced_files_older_than_the_grace_period_are_removed(client):
    kept = provider_icons.store(_image("PNG", color=(1, 2, 3, 255)))
    stale = provider_icons.store(_image("PNG", color=(4, 5, 6, 255)))
    fresh = provider_icons.store(_image("PNG", color=(7, 8, 9, 255)))
    client.post("/api/keys", json=_custom(icon=kept))
    for icon in (kept, stale):
        _age(icon, provider_icons.GRACE_SECONDS + 60)
    client.post("/api/keys", json={**_custom(), "alias": "other"})
    assert provider_icons.file_path(kept[5:]) is not None      # 有引用
    assert provider_icons.file_path(stale[5:]) is None         # 无引用且过期
    assert provider_icons.file_path(fresh[5:]) is not None     # 无引用但在宽限期内


def test_deleting_the_key_releases_its_icon(client):
    icon = provider_icons.store(_image("PNG"))
    client.post("/api/keys", json=_custom(icon=icon))
    _age(icon, provider_icons.GRACE_SECONDS + 60)
    assert client.delete("/api/keys/relay").status_code == 204
    assert provider_icons.file_path(icon[5:]) is None


def test_storing_an_existing_image_again_restarts_its_grace_period(isolated_data_root):
    icon = provider_icons.store(_image("PNG"))
    _age(icon, provider_icons.GRACE_SECONDS + 60)
    provider_icons.store(_image("PNG"))
    provider_icons.prune(set())
    assert provider_icons.file_path(icon[5:]) is not None


def test_prune_leaves_unrelated_files_alone(isolated_data_root):
    folder = provider_icons.icons_dir()
    folder.mkdir(parents=True)
    other = folder / "notes.txt"
    other.write_text("x")
    leftover = folder / f"{'e' * 64}.{'f' * 32}.tmp"  # atomic_write_bytes 中断后留下的临时文件
    leftover.write_bytes(b"x")
    for path in (other, leftover):
        os.utime(path, (0, 0))
    provider_icons.prune(set())
    assert other.exists() and not leftover.exists()


def test_unreadable_icon_folder_never_fails_saving_a_provider(client, monkeypatch):
    """清理在 keys.json 替换之后：目录读不了只记日志，保存供应商照样成功、照样落盘。"""
    provider_icons.icons_dir().mkdir(parents=True)

    def unreadable(self):
        raise PermissionError(13, "Permission denied", str(self))

    monkeypatch.setattr(type(provider_icons.icons_dir()), "iterdir", unreadable)
    assert client.post("/api/keys", json=_custom()).status_code == 201
    assert keys.find_by_alias("relay") is not None
    assert client.patch("/api/keys/relay", json={"notes": "x"}).status_code == 200


def test_store_survives_the_file_being_pruned_between_check_and_touch(isolated_data_root, monkeypatch):
    """同一张图再次存入时旧文件恰好被清理：按新文件写入，不报错。"""
    icon = provider_icons.store(_image("PNG"))
    path = provider_icons.file_path(icon[5:])
    real_utime = os.utime

    def pruned_then_touch(target, *args, **kwargs):
        path.unlink(missing_ok=True)
        return real_utime(target, *args, **kwargs)

    monkeypatch.setattr(provider_icons.os, "utime", pruned_then_touch)
    assert provider_icons.store(_image("PNG")) == icon
    assert provider_icons.file_path(icon[5:]) is not None


# --- 上传接口（I1 2/n）：只返回引用、不改 KEY -------------------------------------------------

def _upload(client, raw: bytes, name="icon.png", content_type="image/png"):
    return client.post("/api/provider-icons", files={"file": (name, raw, content_type)})


def test_upload_returns_a_reference_and_does_not_touch_keys(client):
    response = _upload(client, _image("WEBP"), name="logo.webp", content_type="image/webp")
    assert response.status_code == 200, response.text
    icon = response.json()["icon"]
    assert icon.startswith("file:") and provider_icons.file_path(icon[5:]) is not None
    assert not data_root.keys_file().exists()
    assert client.post("/api/keys", json=_custom(icon=icon)).status_code == 201


@pytest.mark.parametrize(("raw", "name", "content_type"), [
    (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "logo.png", "image/png"),
    (b"<!doctype html><title>x</title>", "favicon.ico", "image/x-icon"),
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 40, "broken.png", "image/png"),
])
def test_upload_rejects_disguised_or_broken_files(client, raw, name, content_type):
    response = _upload(client, raw, name=name, content_type=content_type)
    assert response.status_code == 422
    assert not provider_icons.icons_dir().exists() or not any(provider_icons.icons_dir().iterdir())


def test_upload_over_one_megabyte_is_413(client):
    response = _upload(client, _image("PNG")[:8] + b"\x00" * (provider_icons.MAX_BYTES + 10))
    assert response.status_code == 413


def test_upload_needs_the_local_session(isolated_data_root):
    anonymous = TestClient(build_app(), base_url="http://127.0.0.1:5174")
    anonymous.headers.update({"Origin": "http://127.0.0.1:5174", "Sec-Fetch-Site": "same-origin"})
    response = anonymous.post("/api/provider-icons", files={"file": ("a.png", _image("PNG"), "image/png")})
    assert response.status_code == 401


def test_upload_is_management_and_reading_is_not():
    from viewer_server.connection_capabilities import local_capability

    assert local_capability("POST", "/api/provider-icons") == "manage"
    assert local_capability("GET", "/api/provider-icons/" + "a" * 64) == "read"


# --- 网关只下发 brand:（I1 5/n）----------------------------------------------------------

def _gateway_with_member_icons(icons: dict[str, str | None]):
    from character_workflow.lib import gateway_keys

    for alias, icon in icons.items():
        keys.add_key(keys.KeySpec(
            alias=alias, provider="custom", base_url=f"https://{alias.lower()}.example/v1",
            access_key="host-secret", modalities=["image"], icon=icon, created_at="t",
            models=[keys.ModelSpec(id="img-x", name="Img X", modality="image")]))
    _, token = gateway_keys.create_key("成员")
    gateway = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    return gateway.get("/gateway/v1/models").json()["models"]


def test_gateway_sends_brand_icons_but_never_uploaded_files(isolated_data_root):
    uploaded = provider_icons.store(_image("PNG"))
    [route] = _gateway_with_member_icons({"Brand": "brand:deepseek", "Upload": uploaded, "Plain": None})
    members = {member["alias"]: member for member in route["members"]}
    assert members["Brand"]["icon"] == "brand:deepseek"
    assert "icon" not in members["Upload"] and "icon" not in members["Plain"]
    assert uploaded[5:] not in json.dumps(route) and "host-secret" not in json.dumps(route)


def test_member_snapshot_keeps_only_brand_icons():
    from character_workflow.lib.callers.atelier_gateway import gateway_models

    route = {"id": "img-x", "name": "Img X", "modality": "image", "members": [
        {"alias": "A", "provider": "custom", "model_id": "img-x", "name": "Img X", "icon": "brand:gemini"},
        {"alias": "B", "provider": "custom", "model_id": "img-x", "name": "Img X", "icon": "file:" + "c" * 64},
        {"alias": "C", "provider": "custom", "model_id": "img-x", "name": "Img X"},
    ]}
    [model] = gateway_models([route])
    assert [member.icon for member in model.via] == ["brand:gemini", None, None]
    assert [("icon" in member.model_dump()) for member in model.via] == [True, False, False]


@pytest.mark.parametrize("icon", [123, ["brand:x"], {"brand": "x"}, "brand:", "brand:Has Space",
                                  "brand:" + "x" * 41, "brand:../x", True])
def test_malformed_member_icon_is_dropped_without_failing_the_sync(icon):
    """主机快照里的 icon 来自另一台机器：不合规就当没有，不能让整次网关同步失败。"""
    from character_workflow.lib.callers.atelier_gateway import gateway_models

    route = {"id": "img-x", "name": "Img X", "modality": "image", "members": [
        {"alias": "A", "provider": "custom", "model_id": "img-x", "name": "Img X", "icon": icon}]}
    [model] = gateway_models([route])
    assert model.via[0].icon is None


# --- 按网址获取（I1 6/n）：全部走 outbound_guard.fetch_bounded -----------------------------------

class _DripHandler(BaseHTTPRequestHandler):
    """先回响应头，然后每 0.5 秒吐 1 字节：模拟慢速滴流的上游。"""

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        for _ in range(120):
            if self.server.stopping.is_set():  # type: ignore[attr-defined]
                return
            try:
                self.wfile.write(b"<")
                self.wfile.flush()
            except OSError:
                return
            time.sleep(0.5)


@pytest.fixture
def site(monkeypatch):
    """`*.test` 主机名接到本机假上游，只跳过对它们的公网检查；其余地址（重定向目标、页面里的候选）
    照常走 outbound_guard 的真实检查。"""
    from character_workflow.lib import outbound_guard

    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
        monkeypatch.delenv(name.lower(), raising=False)
    real_open = outbound_guard._open_public
    with FakeVendor() as vendor:
        @contextmanager
        def routed(url, parts, timeout, https_when_proxied=False):
            if parts.hostname and parts.hostname.endswith(".test"):
                local = vendor.url + url.split(parts.netloc, 1)[1]
                with requests.get(local, timeout=timeout, stream=True, allow_redirects=False) as response:
                    yield response
            else:
                with real_open(url, parts, timeout, https_when_proxied) as response:
                    yield response

        monkeypatch.setattr(outbound_guard, "_open_public", routed)
        yield vendor


def _fetch(client, url):
    return client.post("/api/provider-icons/fetch", json={"url": url})


def _paths(vendor):
    return [call.path for call in vendor.calls("GET")]


def _nothing_stored():
    return not provider_icons.icons_dir().exists() or not any(provider_icons.icons_dir().iterdir())


HTML = {"Content-Type": "text/html"}


def test_candidates_prefer_declared_icons_by_size_then_favicon():
    from character_workflow.lib.provider_icon_fetch import candidates

    html = """<html><head><base href="/static/">
      <link rel="icon" href="small.png" sizes="16x16">
      <link rel="apple-touch-icon" href="touch.png">
      <link rel="icon" type="image/svg+xml" href="logo.svg">
      <link rel="shortcut icon" href="https://cdn.example/fav.ico">
      <link rel="stylesheet" href="x.css">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="data:image/png;base64,AAAA">
    </head></html>"""
    assert candidates("https://site.example/docs/", html) == [
        "https://site.example/static/touch.png", "https://site.example/static/small.png",
        "https://cdn.example/fav.ico", "https://site.example/favicon.ico"]
    assert candidates("https://site.example/a", "") == ["https://site.example/favicon.ico"]


def test_page_link_wins_over_favicon(client, site):
    site.on("GET", "/", (200, b'<link rel="icon" href="/brand.png" sizes="64x64">', HTML))
    site.on("GET", "/brand.png", _image("PNG", color=(0, 200, 0, 255)))
    site.on("GET", "/favicon.ico", _image("ICO"))
    response = _fetch(client, "http://site.test/")
    assert response.status_code == 200, response.text
    assert _paths(site) == ["/", "/brand.png"]
    png = provider_icons.file_path(response.json()["icon"][5:]).read_bytes()
    assert _decoded(png).getpixel((64, 64))[1] > 150


def test_relative_icon_resolves_against_the_redirected_page(client, site):
    """`/` 302 到 `/zh/`：页面里的 assets/icon.png 按最终地址解析成 /zh/assets/icon.png。"""
    site.on("GET", "/", (302, b"", {"Location": "/zh/"}))
    site.on("GET", "/zh/", (200, b'<link rel="icon" href="assets/icon.png">', HTML))
    site.on("GET", "/zh/assets/icon.png", _image("PNG"))
    response = _fetch(client, "http://site.test/")
    assert response.status_code == 200, response.text
    assert _paths(site) == ["/", "/zh/", "/zh/assets/icon.png"]


def test_html_or_svg_pretending_to_be_an_icon_is_skipped(client, site):
    site.on("GET", "/", (200, b'<link rel="icon" href="/a.png"><link rel="icon" href="/b.png">', HTML))
    site.on("GET", "/a.png", b"<!doctype html><title>login</title>")
    site.on("GET", "/b.png", b"<svg xmlns='http://www.w3.org/2000/svg'/>")
    site.on("GET", "/favicon.ico", _image("ICO"))
    assert _fetch(client, "http://site.test/").status_code == 200
    assert _paths(site) == ["/", "/a.png", "/b.png", "/favicon.ico"]


def test_candidate_redirecting_into_the_private_network_is_skipped(client, site):
    """候选真的回 302 到 127.0.0.1：重定向目标照常过 outbound_guard 的检查，被拒后换下一个候选。"""
    site.on("GET", "/", (200, b'<link rel="icon" href="/hop.png">', HTML))
    site.on("GET", "/hop.png", (302, b"", {"Location": "http://127.0.0.1:9/secret.png"}))
    site.on("GET", "/favicon.ico", _image("PNG"))
    response = _fetch(client, "http://site.test/")
    assert response.status_code == 200, response.text
    assert _paths(site) == ["/", "/hop.png", "/favicon.ico"]


def test_page_redirecting_into_the_private_network_is_refused(client, site):
    site.on("GET", "/", (302, b"", {"Location": "http://192.168.1.5/"}))
    response = _fetch(client, "http://site.test/")
    assert response.status_code == 422 and response.json()["detail"] == "不能使用本机或内网地址"


def test_malformed_hostnames_are_just_unusable_candidates(client, site):
    site.on("GET", "/", (200, b'<link rel="icon" href="http://a..b/x.png" sizes="64x64">', HTML))
    site.on("GET", "/favicon.ico", _image("PNG"))
    assert _fetch(client, "http://site.test/").status_code == 200
    response = _fetch(client, "http://a..b/")
    assert response.status_code == 422 and response.json()["detail"] == "连接失败"


def test_nothing_usable_is_422_and_stores_nothing(client, site):
    site.on("GET", "/", (200, b'<link rel="icon" href="/1.png"><link rel="icon" href="/2.png">'
                              b'<link rel="icon" href="/3.png"><link rel="icon" href="/4.png">', HTML))
    response = _fetch(client, "http://site.test/")
    assert response.status_code == 422 and response.json()["detail"] == "没有找到图标"
    assert len(_paths(site)) == 1 + 4  # 页面加最多 4 个候选
    assert _nothing_stored()


def test_a_direct_image_address_is_used_as_is(client, site):
    site.on("GET", "/logo.webp", _image("WEBP"))
    response = _fetch(client, "http://site.test/logo.webp")
    assert response.status_code == 200 and _paths(site) == ["/logo.webp"]


def test_a_direct_image_address_has_the_upload_size_limit(client, site):
    site.on("GET", "/big.png", _image("PNG")[:8] + b"\0" * (provider_icons.MAX_BYTES + 10))
    response = _fetch(client, "http://site.test/big.png")
    assert response.status_code == 422 and response.json()["detail"] == "图片超过 1 MB"
    assert _nothing_stored()


def test_an_oversized_page_is_read_up_to_the_limit_and_its_head_still_used(client, site):
    page = b'<html><head><link rel="icon" href="/i.png"></head><body>' + b"x" * (3 << 20)
    site.on("GET", "/", (200, page, HTML))
    site.on("GET", "/i.png", _image("PNG"))
    assert _fetch(client, "http://site.test/").status_code == 200
    assert _paths(site) == ["/", "/i.png"]


def test_a_slow_drip_upstream_ends_within_the_time_budget(client, monkeypatch):
    """上游每 0.5 秒吐 1 字节、永不结束：总时限对单个请求的读取也生效，接口按时返回失败。"""
    from character_workflow.lib import outbound_guard, provider_icon_fetch

    monkeypatch.setattr(provider_icon_fetch, "TOTAL_SECONDS", 2.0)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _DripHandler)
    server.stopping = threading.Event()  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    real_open = outbound_guard._open_public

    @contextmanager
    def routed(url, parts, timeout, https_when_proxied=False):
        if parts.hostname == "drip.test":
            with requests.get(f"http://127.0.0.1:{server.server_port}/", timeout=timeout, stream=True,
                              allow_redirects=False) as response:
                yield response
        else:
            with real_open(url, parts, timeout, https_when_proxied) as response:
                yield response

    monkeypatch.setattr(outbound_guard, "_open_public", routed)
    try:
        started = time.monotonic()
        response = _fetch(client, "http://drip.test/")
        elapsed = time.monotonic() - started
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join()
    assert response.status_code == 422 and response.json()["detail"] == "连接失败"
    assert elapsed < 4.0


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:9/", "http://localhost/", "http://192.168.1.5/", "http://10.0.0.2/x",
    "http://169.254.169.254/latest/meta-data", "http://printer.local/",
    "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/", "http://[fd00::1]/",
])
def test_private_addresses_never_leave_the_machine(client, url, monkeypatch):
    """真实的 outbound_guard：本机、内网、链路本地（含十进制、十六进制与 IPv6 写法）都在连出去之前被拒。"""
    from character_workflow.lib import outbound_guard

    monkeypatch.setattr(outbound_guard.requests.Session, "get",
                        lambda *a, **k: pytest.fail("不应发出请求"))
    response = _fetch(client, url)
    assert response.status_code == 422 and response.json()["detail"] == "不能使用本机或内网地址"


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/x"])
def test_non_http_addresses_are_refused_without_a_request(client, url, monkeypatch):
    from character_workflow.lib import outbound_guard

    monkeypatch.setattr(outbound_guard.requests.Session, "get",
                        lambda *a, **k: pytest.fail("不应发出请求"))
    assert _fetch(client, url).status_code == 422


def test_dns_that_resolves_to_a_private_address_is_refused(client, monkeypatch):
    from character_workflow.lib import outbound_guard

    monkeypatch.setattr(outbound_guard.requests.utils, "get_environ_proxies", lambda _u: {})
    monkeypatch.setattr(outbound_guard.socket, "getaddrinfo",
                        lambda *_a, **_k: [(2, 1, 6, "", ("192.168.1.5", 443))])
    monkeypatch.setattr(outbound_guard.requests.Session, "get",
                        lambda *a, **k: pytest.fail("不应发出请求"))
    response = _fetch(client, "https://rebind.example/")
    assert response.status_code == 422 and response.json()["detail"] == "不能使用本机或内网地址"


class _Sent(Exception):
    pass


def _proxied(monkeypatch, responses):
    """配了代理：记录真正发出去的地址；responses 依次作为响应（空了就抛 _Sent）。"""
    from character_workflow.lib import outbound_guard

    sent = []
    monkeypatch.setattr(outbound_guard.requests.utils, "get_environ_proxies",
                        lambda _u: {"http": "http://proxy.invalid:1", "https": "http://proxy.invalid:1"})

    def get(self, url, **kwargs):
        sent.append(url)
        if not responses:
            raise _Sent(url)
        return responses.pop(0)

    monkeypatch.setattr(outbound_guard.requests.Session, "get", get)
    return sent


def test_via_proxy_third_party_addresses_must_be_https(monkeypatch):
    """走代理时本机看不到真实 IP：页面里解析出的候选与所有重定向目标只放行 https；
    用户亲手填的首个地址维持 ADR-0036 的既有规则。"""
    from character_workflow.lib import outbound_guard

    deadline = time.monotonic() + 5
    sent = _proxied(monkeypatch, [])
    with pytest.raises(outbound_guard.OutboundError, match="https"):
        outbound_guard.fetch_bounded("http://cdn.example/x.png", max_bytes=10, deadline=deadline,
                                     third_party=True)
    assert sent == []
    with pytest.raises(_Sent):
        outbound_guard.fetch_bounded("https://cdn.example/x.png", max_bytes=10, deadline=deadline,
                                     third_party=True)
    with pytest.raises(_Sent):  # 用户填的首个地址：http 也照常经代理发出
        outbound_guard.fetch_bounded("http://user.example/", max_bytes=10, deadline=deadline)

    hop = requests.Response()
    hop.status_code, hop.headers["Location"] = 302, "http://evil.example/"
    hop.raw = BytesIO(b"")
    sent = _proxied(monkeypatch, [hop])
    with pytest.raises(outbound_guard.OutboundError, match="https"):
        outbound_guard.fetch_bounded("http://user.example/", max_bytes=10, deadline=deadline)
    assert sent == ["http://user.example/"]


def test_fetch_is_management_only():
    from viewer_server.connection_capabilities import local_capability

    assert local_capability("POST", "/api/provider-icons/fetch") == "manage"
