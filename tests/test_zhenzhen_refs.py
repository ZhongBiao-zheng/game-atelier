import base64

from character_workflow.lib.callers.zhenzhen_refs import (
    ref_to_banana_image,
    ref_to_file_part,
    upload_ref_to_zhenzhen,
)


PNG_BYTES = b"\x89PNG\r\n\x1a\nfake-png"
JPG_BYTES = b"\xff\xd8\xff\xe0fake-jpg"


def test_ref_to_file_part_parses_data_url():
    data = base64.b64encode(PNG_BYTES).decode("ascii")

    part = ref_to_file_part(f"data:image/png;base64,{data}")

    assert part is not None
    assert part.filename == "reference.png"
    assert part.content_type == "image/png"
    assert part.data == PNG_BYTES


def test_ref_to_file_part_reads_local_png(tmp_path):
    path = tmp_path / "source.png"
    path.write_bytes(PNG_BYTES)

    part = ref_to_file_part(str(path))

    assert part is not None
    assert part.filename == "source.png"
    assert part.content_type == "image/png"
    assert part.data == PNG_BYTES


def test_ref_to_banana_image_keeps_remote_url():
    url = "https://example.com/reference.png"

    assert ref_to_banana_image(url) == url


def test_ref_to_banana_image_converts_local_jpg_to_data_url(tmp_path):
    path = tmp_path / "portrait.jpg"
    path.write_bytes(JPG_BYTES)

    data_url = ref_to_banana_image(str(path))

    assert data_url == f"data:image/jpeg;base64,{base64.b64encode(JPG_BYTES).decode('ascii')}"


def test_upload_ref_to_zhenzhen_posts_file_and_returns_url(monkeypatch, tmp_path):
    path = tmp_path / "reference.png"
    path.write_bytes(PNG_BYTES)
    captured = {}

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"url": "https://cdn.example.com/reference.png"}

    def fake_post(url, headers=None, files=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["files"] = files
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("character_workflow.lib.callers.zhenzhen_refs.requests.post", fake_post)

    result = upload_ref_to_zhenzhen(str(path), "secret-key", "https://api.zhenzhen.ai/")

    assert result == "https://cdn.example.com/reference.png"
    assert captured["url"] == "https://api.zhenzhen.ai/v1/files"
    assert captured["headers"] == {"Authorization": "Bearer secret-key"}
    assert captured["files"] == {"file": ("reference.png", PNG_BYTES, "image/png")}
    assert captured["timeout"] == 180
