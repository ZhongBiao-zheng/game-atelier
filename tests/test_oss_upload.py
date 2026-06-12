from __future__ import annotations

import pytest

from character_workflow.lib import keys as _keys
from character_workflow.lib import oss_upload


class _FakeBucket:
    def __init__(self):
        self.existing: set[str] = set()
        self.put_calls: list[tuple[str, str]] = []

    def object_exists(self, key: str) -> bool:
        return key in self.existing

    def put_object_from_file(self, key: str, path: str) -> None:
        self.put_calls.append((key, path))
        self.existing.add(key)

    def sign_url(self, method: str, key: str, expires: int, slash_safe: bool = False) -> str:
        return f"https://bucket.oss.example/{key}?Expires={expires}&Signature=fake"


@pytest.fixture
def oss_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    db = _keys.read_keys_db()
    db.oss = _keys.OssConfig(
        access_key_id="LTAI-fake",
        access_key_secret="secret-fake",
        bucket="game-atelier-video",
        endpoint="oss-cn-beijing.aliyuncs.com",
    )
    _keys.write_keys_db(db)
    fake = _FakeBucket()
    monkeypatch.setattr(oss_upload, "_bucket", lambda cfg: fake)
    return fake


def test_not_configured_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"mp4")
    with pytest.raises(oss_upload.OssNotConfiguredError, match="尚未配置 OSS"):
        oss_upload.upload_for_url(clip)


def test_missing_file_raises(oss_configured, tmp_path):
    with pytest.raises(oss_upload.OssUploadError, match="不存在"):
        oss_upload.upload_for_url(tmp_path / "gone.mp4")


def test_upload_returns_presigned_url(oss_configured, tmp_path):
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"mp4-bytes")
    url = oss_upload.upload_for_url(clip)
    assert url.startswith("https://bucket.oss.example/video-refs/")
    assert "Signature=" in url
    assert len(oss_configured.put_calls) == 1
    key = oss_configured.put_calls[0][0]
    assert key.startswith("video-refs/") and key.endswith(".mp4")


def test_same_content_uploads_once(oss_configured, tmp_path):
    # 内容 hash 命名：同一文件重复引用只 put 一次（第二次 head 命中跳过）。
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"mp4-bytes")
    url1 = oss_upload.upload_for_url(clip)
    url2 = oss_upload.upload_for_url(clip)
    assert url1 == url2
    assert len(oss_configured.put_calls) == 1


def test_oss_error_translated(oss_configured, tmp_path, monkeypatch):
    def boom(key: str) -> bool:
        raise RuntimeError("AccessDenied")

    monkeypatch.setattr(oss_configured, "object_exists", boom)
    clip = tmp_path / "c.mp4"
    clip.write_bytes(b"mp4")
    with pytest.raises(oss_upload.OssUploadError, match="AccessDenied"):
        oss_upload.upload_for_url(clip)
