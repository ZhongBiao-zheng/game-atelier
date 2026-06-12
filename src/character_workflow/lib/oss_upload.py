"""阿里云 OSS 参考视频中转：本地文件 → 私有 bucket → presigned GET 直链。

厂商参考视频只收公网 http(s) 直链（base64 被上游显式拒，2026-06-12 实测），
本地文件必须先落对象存储。bucket 保持私有读写，直链用带签名的临时 URL，
外人拿不到，厂商在有效期内能拉。
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from character_workflow.lib import keys as _keys

_PREFIX = "video-refs/"
# 任务可能排队 + 厂商异步拉取，给足窗口；远小于 V4 签名 7 天上限。
_PRESIGN_EXPIRES_SECONDS = 24 * 3600


class OssNotConfiguredError(RuntimeError):
    ...


class OssUploadError(RuntimeError):
    ...


def _object_key(path: Path) -> str:
    """内容 hash 命名：同一文件重复引用不重复上传（先 head 后 put）。"""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    ext = path.suffix.lower() or ".bin"
    return f"{_PREFIX}{h.hexdigest()[:24]}{ext}"


def _bucket(cfg: _keys.OssConfig):
    import oss2  # 延迟导入：只有真用到 OSS 中转才付 SDK 启动成本

    endpoint = cfg.endpoint if cfg.endpoint.startswith("http") else f"https://{cfg.endpoint}"
    return oss2.Bucket(oss2.Auth(cfg.access_key_id, cfg.access_key_secret), endpoint, cfg.bucket)


def upload_for_url(path_str: str | Path) -> str:
    """上传本地文件到 OSS，返回 presigned GET 直链（24h 有效）。"""
    cfg = _keys.read_keys_db().oss
    if cfg is None:
        raise OssNotConfiguredError(
            "参考视频是本地文件，需要对象存储中转，但尚未配置 OSS。"
            "请在 .config/keys.json 的 oss 字段配置阿里云 AccessKey/bucket/endpoint。"
        )
    path = Path(path_str)
    if not path.is_file():
        raise OssUploadError(f"参考视频文件不存在: {path_str}")
    key = _object_key(path)
    bucket = _bucket(cfg)
    try:
        if not bucket.object_exists(key):
            bucket.put_object_from_file(key, str(path))
        return bucket.sign_url("GET", key, _PRESIGN_EXPIRES_SECONDS, slash_safe=True)
    except Exception as e:  # noqa: BLE001 — oss2 异常族杂，统一翻译成本项目错误类型
        raise OssUploadError(f"OSS 上传参考视频失败: {e}") from e
