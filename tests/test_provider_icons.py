"""供应商自定义图标（PLAN §8，I1）：校验与重新编码、按内容寻址落盘、读取接口、清理宽限期。"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import time
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import BaseModel, create_model

from character_workflow.lib import data_root, keys, provider_icons
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
    with pytest.raises(provider_icons.IconRejected, match="只支持"):
        provider_icons.normalize(raw)


def test_truncated_png_is_unreadable():
    raw = _image("PNG", size=(64, 64))
    with pytest.raises(provider_icons.IconRejected, match="无法识别"):
        provider_icons.normalize(raw[:60])


def test_over_one_megabyte_is_rejected():
    with pytest.raises(provider_icons.IconRejected, match="1 MB"):
        provider_icons.normalize(_image("PNG")[:8] + b"\x00" * (provider_icons.MAX_BYTES + 1))


def test_wide_png_is_rejected_before_decoding():
    with pytest.raises(provider_icons.IconRejected, match="5000×10"):
        provider_icons.normalize(_image("PNG", size=(5000, 10)))


def test_decompression_bomb_is_rejected_from_the_header(monkeypatch):
    """小文件声明 4000×4001（超 1600 万像素）：只读头部就拒绝，不进解码。"""
    raw = _image("PNG", size=(4000, 4001), color=(0, 0, 0, 0))
    assert len(raw) < 200_000
    monkeypatch.setattr(Image.Image, "load", lambda self: pytest.fail("不应解码"))
    with pytest.raises(provider_icons.IconRejected, match="过大"):
        provider_icons.normalize(raw)


def test_ico_with_a_huge_embedded_png_is_rejected_before_pillow_opens_it():
    """ICO 目录项宽高只有一个字节；内嵌 PNG 的真实尺寸要读它自己的头。"""
    inner = _image("PNG", size=(5000, 5000), color=(0, 0, 0, 0))
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(inner), 6 + 16)
    with pytest.raises(provider_icons.IconRejected, match="过大"):
        provider_icons.normalize(header + entry + inner)


def test_decoder_is_the_one_the_header_names():
    """文件头说 PNG 就只用 PNG 解码器：头部是 PNG、身子是 GIF 的拼接文件解不出来。"""
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
    assert client.patch("/api/keys/relay", json={"icon": icon}).status_code in {404, 422}


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
    os.utime(other, (0, 0))
    provider_icons.prune(set())
    assert other.exists()


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
