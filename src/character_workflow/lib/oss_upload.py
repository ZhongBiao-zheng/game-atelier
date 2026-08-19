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
            "参考素材是本地文件，需要对象存储中转，但尚未配置 OSS。"
            "请在 .config/keys.json 的 oss 字段配置阿里云 AccessKey/bucket/endpoint。"
        )
    path = Path(path_str)
    if not path.is_file():
        raise OssUploadError(f"参考素材文件不存在: {path_str}")
    key = _object_key(path)
    bucket = _bucket(cfg)
    try:
        if not bucket.object_exists(key):
            bucket.put_object_from_file(key, str(path))
        return bucket.sign_url("GET", key, _PRESIGN_EXPIRES_SECONDS, slash_safe=True)
    except Exception as e:  # noqa: BLE001 — oss2 异常族杂，统一翻译成本项目错误类型
        raise OssUploadError(f"OSS 上传参考素材失败: {e}") from e

def upload_for_public_url(path_str: str | Path) -> str:
    """上传并把该对象设为公开读，返回**不带签名**的直链。

    为什么不能用 presigned（upload_for_url）：Midjourney 的 --sref / --cref / --oref 要求
    值是「直接指向图片文件、以 .png/.jpg 结尾」的 URL，而 presigned 链接尾部是
    `?OSSAccessKeyId=...&Expires=...&Signature=...%2F%3D`，那些 & 与转义字符会打断 MJ 的
    flag 解析，上游直接判 `[invalid_parameter] The prompt word format is incorrect`
    （2026-08-19 实测）。而且 MJ 的渲染节点是匿名拉图，presigned 的时效也不适合。

    代价（调用方必须知情）：该对象从此**任何拿到 URL 的人都能读**。只对「为了送进外部
    生成服务而中转」的参考图用它。
    """
    cfg = _keys.read_keys_db().oss
    if cfg is None:
        raise OssNotConfiguredError(
            "参考图要送到 Midjourney，需要一个公网可匿名访问的图片直链，但尚未配置 OSS。"
            "请在 .config/keys.json 的 oss 字段配置阿里云 AccessKey/bucket/endpoint。"
        )
    path = Path(path_str)
    if not path.is_file():
        raise OssUploadError(f"参考素材文件不存在: {path_str}")
    import oss2  # 延迟导入，与 _bucket 同一策略

    key = _object_key(path)
    bucket = _bucket(cfg)
    try:
        if not bucket.object_exists(key):
            bucket.put_object_from_file(key, str(path))
        bucket.put_object_acl(key, oss2.OBJECT_ACL_PUBLIC_READ)
    except Exception as e:  # noqa: BLE001
        # bucket 开了「阻止公共访问」时这里恒 403，原始报文只有 AccessDenied，
        # 不说该去哪改 —— 翻成可操作的指引，否则用户只能对着 403 猜。
        if "public object acl is not allowed" in str(e).lower():
            raise OssUploadError(
                f"OSS bucket「{cfg.bucket}」禁止设置公开读（开启了「阻止公共访问」）。"
                "Midjourney 的参考图必须是匿名可访问的图片直链，所以这张图传不过去。"
                "两种解法：在 OSS 控制台关闭该 bucket 的「阻止公共访问」，"
                "或新建一个允许公开读的 bucket 专门放送外部生成服务的参考图。"
            ) from e
        raise OssUploadError(f"OSS 上传参考素材失败: {e}") from e
    host = cfg.endpoint.replace("https://", "").replace("http://", "").strip("/")
    return f"https://{cfg.bucket}.{host}/{key}"
