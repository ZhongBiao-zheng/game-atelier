"""EvoLink MJ V8.2: one paid submission, durable task recovery and native canvas edits.

Contract: https://evolink.ai/docs/en/api-manual/image-series/midjourney/
mj-v8-2-upload-paint and midjourney-v8-2-prompt-guide (checked 2026-10-15).
Uploads use EvoLink's own temporary file service; they do not require separate OSS credentials.
"""
from __future__ import annotations

import base64
import hashlib
import io
import ipaddress
import math
import re
import socket
import time
import warnings
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

import requests
from PIL import Image, ImageOps, UnidentifiedImageError

from character_workflow.lib import keys
from character_workflow.lib.callers.image_output import write_image

DEFAULT_BASE_URL = "https://api.evolink.ai"
UPLOAD_URL = "https://files-api.evolink.ai/api/v1/files/upload/base64"
_INPUT_LIMIT = 20 * 1024 * 1024
_OUTPUT_LIMIT = 50 * 1024 * 1024
_TRIES = 3
_IMAGE_HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "image/*"}
_FAKE_IP_NETWORK = ipaddress.ip_network("198.18.0.0/15")
# EvoLink's observed MJ output host. Only authenticated vendor HTTPS may use Clash Fake-IP.
_VENDOR_IMAGE_HOSTS = {"openapi-youchuan.oss-cn-shanghai.aliyuncs.com"}
_FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}
_TASK_ID = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
_FLAGS = re.compile(r"(?<!\S)--([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)")
_FLAG_NAMES = {
    "ar", "aspect", "c", "chaos", "seed", "s", "stylize", "exp", "quality", "q",
    "raw", "no", "iw", "sref", "sw", "p", "tile", "weird", "w", "sv",
}
_NUMERIC_FLAGS = {
    "mj_stylize": ("stylize", 0, 1000), "mj_chaos": ("chaos", 0, 100),
    "mj_weird": ("weird", 0, 3000), "mj_seed": ("seed", 0, 4294967295),
    "mj_sw": ("sw", 0, 1000),
}


class EvoLinkError(RuntimeError):
    """A rejected request, uncertain submission or provider-declared terminal failure."""


class EvoLinkPendingError(EvoLinkError):
    """The task is known and can be resumed without another paid POST."""


def _api_root(key) -> str:
    try:
        parts = urlsplit(str(key.base_url or DEFAULT_BASE_URL).strip())
        valid = (parts.scheme == "https" and parts.hostname == "api.evolink.ai"
                 and parts.port in (None, 443) and not parts.username and not parts.password
                 and not parts.query and not parts.fragment
                 and parts.path.rstrip("/") in ("", "/v1"))
    except ValueError:
        valid = False
    if not valid:
        raise EvoLinkError("EvoLink 图片 API 地址必须是 https://api.evolink.ai 或其 /v1 地址")
    return DEFAULT_BASE_URL


def channel_fingerprint(key) -> str:
    return hashlib.sha256(
        f"{_api_root(key)}\0{key.alias}\0{key.access_key}".encode()
    ).hexdigest()


def _public_url(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 1024:
        raise EvoLinkError("EvoLink 图片地址必须是 1024 字符以内的公网 HTTP(S) URL")
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").rstrip(".")
        parts.port
    except ValueError:
        raise EvoLinkError("EvoLink 图片地址无效") from None
    if (parts.scheme not in ("http", "https") or not host or parts.username or parts.password
            or "%" in host or host == "localhost" or host.endswith((".localhost", ".local"))):
        raise EvoLinkError("EvoLink 图片地址必须是公网 HTTP(S) URL")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            # libc also accepts abbreviated, integer and hexadecimal IPv4 spellings.
            address = ipaddress.ip_address(socket.inet_aton(host))
        except OSError:
            return value
    if not address.is_global or address.is_multicast:
        raise EvoLinkError("EvoLink 图片地址不能指向本机或私有网络")
    return value


class _ImageTLSAdapter(requests.adapters.HTTPAdapter):
    """Connect to a checked IP while authenticating the original HTTPS hostname."""

    def __init__(self, hostname: str):
        self.hostname = hostname
        super().__init__(max_retries=0)

    def init_poolmanager(self, connections, maxsize, block=False, **pool_kwargs):
        super().init_poolmanager(connections, maxsize, block,
                                 server_hostname=self.hostname, assert_hostname=self.hostname,
                                 **pool_kwargs)


@contextmanager
def _get_public_image(url: str, *, address_index: int = 0):
    parts = urlsplit(_public_url(url))
    hostname = parts.hostname.encode("idna").decode("ascii")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        answers = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        raise requests.ConnectionError("EvoLink 图片域名无法解析") from None
    addresses = list(dict.fromkeys(ipaddress.ip_address(answer[4][0]) for answer in answers))
    vendor_https = parts.scheme == "https" and (
        hostname in _VENDOR_IMAGE_HOSTS or hostname.endswith(".evolink.ai")
    )
    if not addresses or any(ip.is_multicast or (not ip.is_global and not (
        vendor_https and ip in _FAKE_IP_NETWORK
    )) for ip in addresses):
        raise EvoLinkError("EvoLink 图片地址不能指向本机或私有网络")
    # Rotate validated addresses within the caller's bounded retry budget (IPv6/IPv4).
    address = str(addresses[address_index % len(addresses)])
    if ":" in address:
        address = f"[{address}]"
    pinned_url = urlunsplit((parts.scheme, f"{address}:{port}", parts.path, parts.query, ""))
    with requests.Session() as session:
        # No ambient proxy/netrc credentials; a proxy would resolve the hostname again.
        session.trust_env = False
        if parts.scheme == "https":
            session.mount("https://", _ImageTLSAdapter(hostname))
        with session.get(pinned_url, headers={**_IMAGE_HEADERS, "Host": parts.netloc},
                         timeout=(10, 60), stream=True, allow_redirects=False) as response:
            yield response


def _json(response) -> dict[str, Any]:
    try:
        payload = response.json()
    except (ValueError, requests.RequestException):
        raise EvoLinkError("EvoLink 返回了无法解析的响应") from None
    if not isinstance(payload, dict):
        raise EvoLinkError("EvoLink 返回了无效的响应结构")
    return payload


def _error(payload: dict, status: int, secret: str) -> str:
    error = payload.get("error")
    error = error if isinstance(error, dict) else {}
    message = str(error.get("message") or payload.get("msg") or "请求未成功")
    if secret:
        message = message.replace(secret, "[已隐藏]")
    message = re.sub(r"(?i)Bearer\s+\S+", "Bearer [已隐藏]", message)
    labels = {401: "密钥无效或已过期", 402: "额度不足", 403: "没有访问权限",
              429: "请求频率受限"}
    label = "任务失败" if status == 200 else f"HTTP {status} {labels.get(status, '')}".rstrip()
    return f"EvoLink {label}：{message[:600]}"


def _image_info(content: bytes) -> tuple[tuple[int, int], str]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                if image.format not in _FORMATS or max(image.size) > 16000:
                    raise EvoLinkError("EvoLink 图片需为 PNG/JPEG/WebP/GIF，单边最多 16000 像素")
                size, mime = image.size, _FORMATS[image.format]
                image.verify()
            with Image.open(io.BytesIO(content)) as image:
                image.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise EvoLinkError("EvoLink 图片文件无效、损坏或尺寸过大") from None
    return size, mime


def _download(url: str, *, limit: int = _OUTPUT_LIMIT) -> bytes:
    """Download with no provider credentials, bounded retries and bounded response size."""
    _public_url(url)
    status = None
    for attempt in range(_TRIES):
        try:
            with _get_public_image(url, address_index=attempt) as resp:
                status = resp.status_code
                if status in (301, 302, 303, 307, 308):
                    url = _public_url(urljoin(url, resp.headers.get("Location", "")))
                    continue
                if resp.ok:
                    content = bytearray()
                    for chunk in resp.iter_content(chunk_size=64 * 1024):
                        content.extend(chunk)
                        if len(content) > limit:
                            raise EvoLinkError("EvoLink 图片超过允许的文件大小")
                    return bytes(content)
                if status not in (408, 429) and status < 500:
                    break
        except requests.RequestException:
            status = None
        if attempt < _TRIES - 1:
            time.sleep(2 * (attempt + 1))
    reason = f"HTTP {status}" if status else "网络连接失败"
    raise EvoLinkError(f"EvoLink 图片下载失败（{reason}）") from None


def _read_input(value: str) -> tuple[bytes, tuple[int, int], str]:
    if value.startswith(("http://", "https://")):
        content = _download(value, limit=_INPUT_LIMIT)
    else:
        try:
            path = Path(value)
            if path.stat().st_size > _INPUT_LIMIT:
                raise EvoLinkError("EvoLink 参考图最大为 20 MB")
            content = path.read_bytes()
        except OSError:
            raise EvoLinkError("EvoLink 无法读取参考图，请重新选择图片") from None
    size, mime = _image_info(content)
    return content, size, mime


def _upload(content: bytes, mime: str, key) -> str:
    """EvoLink file upload (72h retention); never uses third-party OSS configuration."""
    body = {"base64_data": f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"}
    try:
        response = requests.post(UPLOAD_URL, headers={"Authorization": f"Bearer {key.access_key}"},
                                 json=body, timeout=(10, 120), allow_redirects=False)
    except requests.RequestException:
        raise EvoLinkError("EvoLink 参考图上传中断，尚未提交出图任务") from None
    payload = _json(response)
    if not response.ok or payload.get("success") is not True:
        raise EvoLinkError(_error(payload, response.status_code, key.access_key))
    data = payload.get("data")
    return _public_url(data.get("file_url") if isinstance(data, dict) else None)


def _reference_url(value: str, key) -> str:
    if value.startswith(("http://", "https://")):
        return _public_url(value)
    content, _size, mime = _read_input(value)
    return _upload(content, mime, key)


def _edit_source(value: str) -> tuple[bytes, tuple[int, int]]:
    """Match the Canvas display orientation before measuring, masking and uploading."""
    content, _size, _mime = _read_input(value)
    with Image.open(io.BytesIO(content)) as image:
        displayed = ImageOps.exif_transpose(image)
        mode = "RGBA" if "A" in displayed.getbands() or "transparency" in displayed.info else "RGB"
        normalized = displayed.convert(mode)
        normalized.info.clear()
        stream = io.BytesIO()
        normalized.save(stream, format="PNG")
        content = stream.getvalue()
        if len(content) > _INPUT_LIMIT:
            raise EvoLinkError("EvoLink 编辑原图转换为 PNG 后超过 20 MB，请缩小原图")
        return content, normalized.size


def mask_data_uri(path: str | Path, source_size: tuple[int, int]) -> str:
    """Internal white=keep, black=edit → EvoLink opaque black=keep, white=repaint."""
    try:
        with Image.open(path) as image:
            if image.size != source_size:
                raise EvoLinkError("EvoLink 蒙版尺寸必须与原图一致")
            mask = ImageOps.invert(image.convert("L")).point(lambda value: 255 if value >= 128 else 0)
    except (OSError, ValueError):
        raise EvoLinkError("EvoLink 无法读取编辑蒙版") from None
    stream = io.BytesIO()
    mask.save(stream, format="PNG")
    return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
        if isinstance(value, bool) or float(value) != number or not minimum <= number <= maximum:
            raise ValueError
    except (ValueError, TypeError, OverflowError):
        raise EvoLinkError(f"EvoLink {label} 必须是 {minimum}–{maximum} 的整数") from None
    return number


def _validate_prompt_flags(prompt: str) -> None:
    matches = list(_FLAGS.finditer(prompt))
    values = {}
    limits = {"c": (0, 100), "chaos": (0, 100), "s": (0, 1000), "stylize": (0, 1000),
              "seed": (0, 4294967295), "exp": (0, 100), "q": (1, 4), "quality": (1, 4),
              "sw": (0, 1000), "weird": (0, 3000), "w": (0, 3000), "sv": (6, 6)}
    for index, match in enumerate(matches):
        name = match[1]
        if name not in _FLAG_NAMES:
            raise EvoLinkError(f"EvoLink 当前不支持提示词参数 --{name}")
        end = matches[index + 1].start() if index + 1 < len(matches) else len(prompt)
        value = prompt[match.end():end].strip()
        values[name] = value
        if name in limits:
            _integer(value, f"--{name}", *limits[name])
        elif name in ("ar", "aspect") and not re.fullmatch(r"[1-9]\d*:[1-9]\d*", value):
            raise EvoLinkError("EvoLink --ar 必须是正整数比例")
        elif name == "iw":
            try:
                valid = 0 <= float(value) <= 3
            except (ValueError, OverflowError):
                valid = False
            if not valid:
                raise EvoLinkError("EvoLink --iw 必须在 0–3 之间")
        elif name in ("raw", "tile") and value:
            raise EvoLinkError(f"EvoLink --{name} 后不能附加文字或数值")
        elif name == "p" and not re.fullmatch(r"[A-Za-z0-9]{1,64}", value):
            raise EvoLinkError("EvoLink --p 仅接受平台上游渠道的 Moodboard ID")
        elif name not in ("raw", "tile") and not value:
            raise EvoLinkError(f"EvoLink --{name} 缺少参数值")
    if "p" in values and ({"weird", "w"} & values.keys()):
        raise EvoLinkError("EvoLink --p 不能与 --weird 同时使用")
    if "sv" in values and "sref" not in values:
        raise EvoLinkError("EvoLink --sv 需要 --sref")


def _validate_options(prompt: str, params: dict, *, editing: bool) -> None:
    if str(params.get("mode") or "fast").lower() != "fast":
        raise EvoLinkError("EvoLink 当前仅支持 Fast 模式")
    if str(params.get("quality") or "standard").lower() != "standard":
        raise EvoLinkError("EvoLink 当前仅支持 Standard 输出质量")
    if params.get("mj_version") not in (None, "", "8.2"):
        raise EvoLinkError("EvoLink 当前模型固定为 Midjourney V8.2")
    if params.get("bot_type") not in (None, "", "MID_JOURNEY"):
        raise EvoLinkError("EvoLink V8.2 不支持 Niji")
    if any(params.get(name) for name in ("mj_cref", "mj_cw", "mj_oref", "mj_ow")):
        raise EvoLinkError("EvoLink V8.2 不支持 --cref / --oref 角色参考")
    if params.get("mj_profile"):
        raise EvoLinkError("EvoLink 不支持 Midjourney.com 的个人 Profile；请改用风格参考")
    known = {"mj_version", "mj_flags", "mj_iw", "mj_no", "mj_tile", "mj_sref", "mj_sref_code",
             "mj_profile", "mj_cref", "mj_cw", "mj_oref", "mj_ow", *_NUMERIC_FLAGS}
    for name, value in params.items():
        if name.startswith("mj_") and name not in known and value not in (None, [], "", False):
            raise EvoLinkError(f"EvoLink 尚未支持参数 {name}")
    names = _FLAGS.findall(prompt)
    _validate_prompt_flags(prompt)
    if "::" in prompt:
        raise EvoLinkError("EvoLink V8.2 不支持多提示词 :: 语法")
    if editing:
        for name in ("mj_iw", "mj_sref", "mj_sref_code", "mj_tile", "mj_no", *_NUMERIC_FLAGS):
            if params.get(name) not in (None, [], "", False):
                raise EvoLinkError(f"EvoLink 原生编辑尚未支持参数 {name}")
        if names:
            raise EvoLinkError("EvoLink 原生编辑请使用文字编辑说明，不附加生成参数")


def _generation_body(prompt: str, params: dict, key) -> dict:
    parts = [prompt.strip()]
    ratio = params.get("ratio")
    if ratio and ratio != "auto":
        if not re.fullmatch(r"[1-9]\d*:[1-9]\d*", str(ratio)):
            raise EvoLinkError("EvoLink 比例必须是正整数比例，例如 16:9")
        parts.append(f"--ar {ratio}")
    for name, (flag, low, high) in _NUMERIC_FLAGS.items():
        value = params.get(name)
        if value is not None:
            parts.append(f"--{flag} {_integer(value, flag, low, high)}")
    refs = params.get("reference_images") or []
    srefs = params.get("mj_sref") or []
    if not isinstance(refs, list) or not isinstance(srefs, list) or max(len(refs), len(srefs)) > 20:
        raise EvoLinkError("EvoLink 垫图与风格参考各最多 20 张")
    code = params.get("mj_sref_code")
    if code and not re.fullmatch(r"[0-9]{1,32}", str(code)):
        raise EvoLinkError("EvoLink sref 编号只允许最多 32 位数字")
    if code and srefs:
        raise EvoLinkError("EvoLink 风格参考图片和 sref 编号请只选一种")
    if params.get("mj_sw") is not None and not (srefs or code or "--sref " in prompt):
        raise EvoLinkError("EvoLink 风格权重需要风格参考")
    if params.get("mj_iw") is not None:
        if not refs and not re.search(r"https?://", prompt):
            raise EvoLinkError("EvoLink 垫图权重需要参考图片")
        try:
            weight = float(params["mj_iw"])
        except (ValueError, TypeError):
            raise EvoLinkError("EvoLink 垫图权重必须在 0–3 之间") from None
        if not 0 <= weight <= 3:
            raise EvoLinkError("EvoLink 垫图权重必须在 0–3 之间")
        parts.append(f"--iw {weight:g}")
    if params.get("mj_no"):
        negative = str(params["mj_no"]).strip()
        if "--" in negative:
            raise EvoLinkError("EvoLink 排除词不能包含额外参数")
        parts.append(f"--no {negative}")
    if params.get("mj_tile"):
        parts.append("--tile")
    # Validate conflicts involving both UI controls and parameters typed into the prompt.
    _validate_prompt_flags(" ".join(parts))
    description = re.sub(r"https?://\S+", "", prompt.split(" --", 1)[0]).strip()
    if len(description) > 1024:
        raise EvoLinkError("EvoLink 普通生成的文字描述最多 1024 字符")
    if not description and (srefs or code or len(refs) < 2):
        raise EvoLinkError("EvoLink 需要文字提示词；无文字时至少需要两张垫图")
    if not description and any(params.get(name) is not None for name in ("mj_stylize", "mj_weird")):
        raise EvoLinkError("EvoLink 无文字垫图不支持 stylize / weird 参数")
    # All structured validation above runs before even the unbilled file uploads.
    if code or srefs:
        parts.append("--sref " + (str(code) if code else " ".join(
            _reference_url(str(value), key) for value in srefs)))
    final_prompt = " ".join([*[_reference_url(str(value), key) for value in refs], *parts])
    if len(final_prompt) > 2048:
        raise EvoLinkError("EvoLink 普通生成的提示词、参考地址和参数合计最多 2048 字符")
    return {"model": "mj-v8.2", "prompt": final_prompt, "quality": "standard",
            "model_params": {"speed": "fast"}}


def _edit_body(prompt: str, params: dict, key) -> dict:
    options = params["image_edit"]
    if not isinstance(options, dict) or options.get("mode") not in ("inpaint", "outpaint"):
        raise EvoLinkError("EvoLink 原生编辑只支持局部重绘和扩图")
    if not prompt.strip() or len(prompt) > 8100:
        raise EvoLinkError("EvoLink 编辑说明必须是 1–8100 字符")
    refs = params.get("reference_images") or []
    if len(refs) != 1 or not params.get("mask_image"):
        raise EvoLinkError("EvoLink 原生编辑需要一张原图和一张蒙版")
    content, (width, height) = _edit_source(str(refs[0]))
    canvas = {name: _integer(options.get(name, default), name, 1, 16000)
              for name, default in (("width", width), ("height", height))}
    position = {"width": width, "height": height,
                "x": _integer(options.get("x", 0), "x", -16000, 16000),
                "y": _integer(options.get("y", 0), "y", -16000, 16000)}
    if options["mode"] == "inpaint" and (
        canvas != {"width": width, "height": height} or position["x"] or position["y"]
    ):
        raise EvoLinkError("EvoLink 局部重绘必须保持原图画布尺寸和位置")
    if (position["x"] >= canvas["width"] or position["y"] >= canvas["height"]
            or position["x"] + width <= 0 or position["y"] + height <= 0):
        raise EvoLinkError("EvoLink 原图必须与目标画布相交")
    mask = mask_data_uri(params["mask_image"], (width, height))
    source_url = _upload(content, "image/png", key)
    return {"model": "mj-v8.2-upload-paint", "prompt": prompt.strip(),
            "image_urls": [source_url], "model_params": {"mask": {"url": mask},
            "canvas": canvas, "img_pos": position, "speed": "fast"}}


def _result_urls(payload: dict) -> list[str]:
    results = payload.get("results")
    if not results:
        results = [item.get("url") for item in (payload.get("result_data") or [])
                   if isinstance(item, dict)]
    if not isinstance(results, list) or not 1 <= len(results) <= 4:
        raise EvoLinkError("EvoLink 任务已完成，但返回的结果不是 1–4 张图片")
    return [_public_url(url) for url in results]


def render(
    *, prompt: str, model: str, alias: str, output_dir: Path | str, n: int = 4,
    params: dict[str, Any] | None = None, on_phase: Callable[[str], None] | None = None,
    on_params_changed: Callable[[], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    on_cost_usd: Callable[[float], None] | None = None,
    max_polls: int = 400, poll_interval: float = 3.0, **_kwargs,
) -> list[str]:
    """Run exactly one generation; every resume reuses the persisted task and result URLs."""
    params = params if params is not None else {}
    state = params.get("evolink_state")
    if state is None:
        state = {}
        params["evolink_state"] = state
    if not isinstance(state, dict):
        raise EvoLinkError("EvoLink 任务恢复信息无效")
    key = keys.find_by_alias(alias)
    if key is None or key.provider != "evolink":
        raise EvoLinkError("未找到 EvoLink 密钥，请检查当前供应商配置")
    root = _api_root(key)
    channel = channel_fingerprint(key)
    if state.get("channel") and state["channel"] != channel:
        raise EvoLinkError("EvoLink 原任务的密钥或 API 地址已改变，不能跨渠道恢复")
    if model != "mj-v8.2":
        raise EvoLinkError("EvoLink 当前仅开放 mj-v8.2；编辑由原图和蒙版触发")

    def save():
        if on_params_changed:
            on_params_changed()

    def pause(message):
        state["poll_paused"] = True
        save()
        raise EvoLinkPendingError(f"{message}；可继续原任务（task_id={task_id}）") from None

    def canceled():
        return bool(should_cancel and should_cancel())

    if state.get("terminal") in ("failed", "rejected"):
        raise EvoLinkError(state.get("error") or "EvoLink 原任务已失败，不会自动重新提交")
    task_id = str(state.get("task_id") or "")
    if task_id and not _TASK_ID.fullmatch(task_id):
        raise EvoLinkError("EvoLink 已保存的任务 ID 无效")
    if not task_id:
        if state.get("uncertain"):
            raise EvoLinkError("EvoLink 上次提交结果未确认，请核对供应商订单；不会重复提交")
        _integer(n, "单次张数", 1, 4)
        _validate_options(prompt, params, editing=bool(params.get("image_edit")))
        if canceled():
            raise EvoLinkError("已停止，尚未提交 EvoLink 任务")
        body = (_edit_body(prompt, params, key) if params.get("image_edit")
                else _generation_body(prompt, params, key))
        if canceled():
            raise EvoLinkError("已停止，尚未提交 EvoLink 任务")
        # Persist before the paid POST. Even a process crash cannot make this job submit twice.
        state.update(uncertain=True, channel=channel, poll_paused=False)
        save()
        try:
            response = requests.post(f"{root}/v1/images/generations",
                                     headers={"Authorization": f"Bearer {key.access_key}"},
                                     json=body, timeout=(10, 120), allow_redirects=False)
        except requests.RequestException:
            raise EvoLinkError("EvoLink 提交响应中断，受理结果未确认；请核对订单，不会重复提交") from None
        try:
            payload = _json(response)
        except EvoLinkError:
            raise EvoLinkError("EvoLink 提交返回异常，受理结果未确认；请核对订单，不会重复提交") from None
        candidate = str(payload.get("id") or "")
        if candidate and _TASK_ID.fullmatch(candidate):
            task_id = candidate
            state.update(task_id=task_id, uncertain=False)
            params.update(provider_task_ids=[task_id], provider_task_protocol="evolink")
            save()
        elif not response.ok and 400 <= response.status_code < 500 and response.status_code != 408:
            message = _error(payload, response.status_code, key.access_key)
            state.update(uncertain=False, terminal="rejected", error=message)
            save()
            raise EvoLinkError(message)
        else:
            raise EvoLinkError("EvoLink 提交未返回任务 ID，受理结果未确认；请核对订单，不会重复提交")
    params.update(provider_task_ids=[task_id], provider_task_protocol="evolink")
    state.update(channel=channel, uncertain=False, poll_paused=False)
    save()
    if on_phase:
        on_phase("sent")
    if state.get("terminal") != "completed" or not state.get("results"):
        consecutive_errors = 0
        for _ in range(max_polls):
            if canceled():
                pause("已停止查询，EvoLink 上游任务仍可能继续执行")
            try:
                response = requests.get(f"{root}/v1/tasks/{quote(task_id, safe='')}",
                                        headers={"Authorization": f"Bearer {key.access_key}"},
                                        timeout=(10, 30), allow_redirects=False)
                if response.status_code in (408, 429) or response.status_code >= 500:
                    raise requests.RequestException()
                payload = _json(response)
            except (requests.RequestException, EvoLinkError):
                consecutive_errors += 1
                if consecutive_errors >= _TRIES:
                    pause("EvoLink 查询连续失败，已暂停")
            else:
                consecutive_errors = 0
                if not response.ok:
                    pause(_error(payload, response.status_code, key.access_key))
                if payload.get("id") not in (None, task_id):
                    pause("EvoLink 查询返回了不同的任务 ID")
                status = payload.get("status")
                if status == "failed":
                    message = f"{_error(payload, 200, key.access_key)}（task_id={task_id}）"
                    state.update(terminal="failed", error=message, poll_paused=False)
                    save()
                    raise EvoLinkError(message)
                if status == "completed":
                    state["terminal"] = "completed"
                    try:
                        state["results"] = _result_urls(payload)
                    except EvoLinkError as error:
                        pause(str(error))
                    usage = payload.get("usage") or {}
                    cost = usage.get("cost") if isinstance(usage, dict) else None
                    usd = cost.get("usd") if isinstance(cost, dict) else None
                    if isinstance(usd, (int, float)) and math.isfinite(usd) and usd >= 0:
                        state["cost_usd"] = usd
                    save()
                    break
                if status not in ("pending", "processing"):
                    pause("EvoLink 返回了未知任务状态")
            if poll_interval:
                time.sleep(poll_interval)
        else:
            pause("EvoLink 任务尚未完成，已暂停查询")
    if on_cost_usd and "cost_usd" in state:
        on_cost_usd(state["cost_usd"])
    if on_phase:
        on_phase("downloading")
    paths = []
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    for index, url in enumerate(state["results"], 1):
        if canceled():
            pause("已停止下载，EvoLink 结果已保存")
        try:
            content = _download(url)
            _image_info(content)
            paths.append(str(write_image(directory, f"evolink-{index}", content)))
        except (EvoLinkError, OSError):
            pause(f"EvoLink 已经出图，但第 {index} 张图片下载或保存失败")
    params.update(n=len(paths), actual_n=len(paths))
    state["poll_paused"] = False
    save()
    return paths
