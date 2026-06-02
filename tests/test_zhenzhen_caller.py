import base64
import json

import requests

from character_workflow.lib import keys
from character_workflow.lib.callers import zhenzhen


def _add_key(alias: str = "zz") -> None:
    keys.add_key(
        keys.KeySpec(
            alias=alias,
            provider="custom",
            base_url="https://ai.t8star.org",
            access_key="zz-secret",
            secret_key=None,
            capabilities=["portrait", "promo", "turnaround"],
            models=[{"name": "GPT Image 2", "id": "gpt-image-2-all"}],
            routing_scope="general",
            routing_category=None,
            routing_hints=[],
            modalities=["image"],
            notes="",
            created_at="2026-05-28T00:00:00+08:00",
        )
    )


class FakeResponse:
    def __init__(self, payload, *, status_code=200, content=b""):
        self._payload = payload
        self.status_code = status_code
        self.ok = status_code < 400
        self.content = content
        self.headers = {"content-type": "image/png"}
        self.text = json.dumps(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise requests.HTTPError(self.text)


def test_render_downloads_sync_b64_image(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    img = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 32).decode("ascii")
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse({"data": [{"b64_json": img}]})

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)

    paths = zhenzhen.render(
        prompt="fox",
        model="gpt-image-2-all",
        alias="zz",
        output_dir=tmp_path,
        n=2,
        params={"aspect_ratio": "1:1", "image_size": "2K", "reference_images": []},
    )

    assert len(paths) == 1
    assert (tmp_path / "v1.png").read_bytes().startswith(b"\x89PNG")
    assert calls[0][0] == "https://ai.t8star.org/v1/images/edits?async=true"
    assert calls[0][1]["headers"]["Authorization"] == "Bearer zz-secret"
    assert calls[0][1]["data"]["n"] == "2"


def test_render_polls_async_task_and_remembers_alias(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    image_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * 32
    post_calls = []
    get_calls = []

    def fake_post(url, **kwargs):
        post_calls.append((url, kwargs))
        return FakeResponse({"data": "task-123"})

    def fake_get(url, **kwargs):
        get_calls.append((url, kwargs))
        return FakeResponse({
            "data": {
                "status": "success",
                "data": {"data": [{"url": "https://cdn.example.com/out.png"}]},
            }
        })

    def fake_download(url, timeout=180.0):
        return FakeResponse({}, content=image_bytes)

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)
    monkeypatch.setattr(zhenzhen.requests, "get", fake_get)
    monkeypatch.setattr(zhenzhen, "_download_url", fake_download)

    paths = zhenzhen.render(
        prompt="fox",
        model="nano-banana-pro",
        alias="zz",
        output_dir=tmp_path,
        n=1,
        params={"aspect_ratio": "1:1", "image_size": "2K", "reference_images": []},
        poll_interval=0,
        max_polls=1,
    )

    assert len(paths) == 1
    assert (tmp_path / "v1.png").read_bytes() == image_bytes
    assert get_calls[0][0] == "https://ai.t8star.org/v1/images/tasks/task-123"
    assert get_calls[0][1]["headers"]["Authorization"] == "Bearer zz-secret"


def test_render_uses_banana_edit_fields_when_refs_exist(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    ref = tmp_path / "ref.png"
    ref.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 32)
    calls = []
    img = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"y" * 32).decode("ascii")

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse({"data": [{"b64_json": img}]})

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)

    zhenzhen.render(
        prompt="fox",
        model="nano-banana-pro",
        alias="zz",
        output_dir=tmp_path,
        n=3,
        params={"aspect_ratio": "16:9", "image_size": "4K", "reference_images": [str(ref)]},
    )

    assert calls[0][0] == "https://ai.t8star.org/v1/images/edits?async=true"
    assert calls[0][1]["data"] == {
        "prompt": "fox",
        "model": "nano-banana-pro",
        "n": 3,
        "size": "16x9",
        "quality": "medium",
    }
    assert calls[0][1]["files"][0][0] == "image"


def test_render_routes_mj_protocol(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    image_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * 32
    post_calls = []
    get_calls = []

    def fake_post(url, **kwargs):
        post_calls.append((url, kwargs))
        return FakeResponse({"result": "mj-task-1"})

    def fake_get(url, **kwargs):
        get_calls.append((url, kwargs))
        return FakeResponse({"status": "SUCCESS", "imageUrl": "https://cdn.example.com/mj.png"})

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)
    monkeypatch.setattr(zhenzhen.requests, "get", fake_get)
    monkeypatch.setattr(zhenzhen, "_download_url", lambda *args, **kwargs: FakeResponse({}, content=image_bytes))

    paths = zhenzhen.render(
        prompt="castle",
        model="midjourney",
        alias="zz",
        output_dir=tmp_path,
        params={"aspect_ratio": "16:9", "seed": 123, "speed": "fast"},
        poll_interval=0,
        max_polls=1,
    )

    assert len(paths) == 1
    assert post_calls[0][0] == "https://ai.t8star.org/mj-fast/mj/submit/imagine"
    assert post_calls[0][1]["json"]["ar"] == "16:9"
    assert get_calls[0][0] == "https://ai.t8star.org/mj-fast/mj/task/mj-task-1/fetch"


def test_render_routes_fal_protocol(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    image_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * 32
    post_calls = []
    get_calls = []

    def fake_post(url, **kwargs):
        post_calls.append((url, kwargs))
        return FakeResponse({
            "request_id": "fal-req-1",
            "response_url": "https://queue.fal.run/openai/gpt-image-2/requests/fal-req-1",
        })

    def fake_get(url, **kwargs):
        get_calls.append((url, kwargs))
        return FakeResponse({"images": [{"url": "https://cdn.example.com/fal.png"}]})

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)
    monkeypatch.setattr(zhenzhen.requests, "get", fake_get)
    monkeypatch.setattr(zhenzhen, "_download_url", lambda *args, **kwargs: FakeResponse({}, content=image_bytes))

    paths = zhenzhen.render(
        prompt="fox",
        model="gpt-image-2-fal",
        alias="zz",
        output_dir=tmp_path,
        params={"size": "1024x1024"},
        poll_interval=0,
        max_polls=1,
    )

    assert len(paths) == 1
    assert post_calls[0][0] == "https://ai.t8star.org/fal/openai/gpt-image-2"
    assert post_calls[0][1]["json"]["prompt"] == "fox"
    assert get_calls[0][0] == "https://ai.t8star.org/fal/openai/gpt-image-2/requests/fal-req-1"


def test_render_wraps_poll_bad_json_as_zhenzhen_error(isolated_data_root, tmp_path, monkeypatch):
    _add_key()

    class BadJsonResponse(FakeResponse):
        text = "<html>bad gateway</html>"

        def json(self):
            raise ValueError("bad json")

    monkeypatch.setattr(zhenzhen.requests, "post", lambda *args, **kwargs: FakeResponse({"data": "task-123"}))
    monkeypatch.setattr(zhenzhen.requests, "get", lambda *args, **kwargs: BadJsonResponse({}))

    try:
        zhenzhen.render(
            prompt="fox",
            model="nano-banana-pro",
            alias="zz",
            output_dir=tmp_path,
            params={"reference_images": []},
            poll_interval=0,
            max_polls=1,
        )
    except zhenzhen.ZhenzhenError as e:
        assert "上游响应非 JSON" in str(e)
    else:
        raise AssertionError("expected ZhenzhenError")


def test_render_wraps_artifact_download_failure(isolated_data_root, tmp_path, monkeypatch):
    _add_key()

    def fake_post(*args, **kwargs):
        return FakeResponse({"data": [{"url": "https://cdn.example.com/missing.png"}]})

    def fake_download(*args, **kwargs):
        raise requests.HTTPError("404")

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)
    monkeypatch.setattr(zhenzhen, "_download_url", fake_download)

    try:
        zhenzhen.render(
            prompt="fox",
            model="gpt-image-2-all",
            alias="zz",
            output_dir=tmp_path,
            params={"reference_images": []},
        )
    except zhenzhen.ZhenzhenError as e:
        assert "下载上游图片失败" in str(e)
    else:
        raise AssertionError("expected ZhenzhenError")
