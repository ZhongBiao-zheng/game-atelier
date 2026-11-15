"""自定义接口（声明式 HTTP 接口模板）版本 1 的结构与静态校验。

模板只描述「怎么把一次生成翻译成 HTTP 请求、从哪取结果」。地址只能写相对路径，请求永远发往
供应商自己的 base_url；密钥不进模板。校验只在 API 写入边界执行（见 ADR-0036）：读盘时同一套
校验失败只让这一份模板不可用，不影响 keys.json 与其它模板。
"""
from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

PROTOCOL_VERSION = 1

# 内置占位符 → 可用范围。taskId 只在轮询里有意义；时长与首尾帧只对视频有意义；
# 音色、语速、格式、歌词、纯音乐只对音频有意义。
BUILTIN_PLACEHOLDERS: dict[str, str] = {
    "prompt": "any", "model": "any", "n": "any", "ratio": "visual", "resolution": "visual",
    "duration": "video", "durationText": "video", "images": "visual", "image": "visual",
    "firstFrame": "video", "lastFrame": "video", "taskId": "poll",
    "voice": "audio", "speed": "audio", "format": "audio", "lyrics": "audio",
    "instrumental": "audio",
}
IMAGE_PLACEHOLDERS = frozenset({"images", "image", "firstFrame", "lastFrame"})
# 用到其中任一个即为音乐接口，否则音频接口按语音处理。
MUSIC_PLACEHOLDERS = frozenset({"lyrics", "instrumental"})
# 派生值只能从这些单值占位符换算。
DERIVABLE = frozenset({"ratio", "resolution", "duration", "n", "model",
                       "voice", "speed", "format", "instrumental"})
AUDIO_FORMATS = ("mp3", "wav", "flac", "opus", "aac")
AUDIO_MAX_COUNT = 2
# 固定请求头里不允许出现的键：鉴权由 auth 注入，其余由 HTTP 库负责。
FORBIDDEN_HEADERS = frozenset({
    "authorization", "proxy-authorization", "host", "cookie", "content-length",
    "transfer-encoding", "connection",
})

MAX_DOCUMENT_BYTES = 64 * 1024
MAX_DEPTH = 12
MAX_ARRAY_ITEMS = 64
MAX_PATH_SEGMENTS = 8

_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$")
# CR / LF 等控制字符会拆出第二个请求头（头注入）；制表符在 HTTP 头值里合法。
_CONTROL = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")
WHOLE = re.compile(r"^\$([A-Za-z][A-Za-z0-9_]*)$")
BRACED = re.compile(r"\$\{([^}]*)\}")
_BARE = re.compile(r"\$([A-Za-z][A-Za-z0-9_]*)")
_RESULT_PATH = re.compile(r"^(?:[A-Za-z0-9_-]+|\*|\d+)(?:\.(?:[A-Za-z0-9_-]+|\*|\d+))*$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Auth(_Strict):
    type: Literal["bearer", "header", "query", "none"]
    name: str | None = Field(default=None, max_length=64)
    prefix: str | None = Field(default=None, max_length=32)


class ImageInputs(_Strict):
    max: int = Field(ge=1, le=16)
    # url：本机文件先经对象存储中转成签名直链（需要配置 OSS，保存时检查，见 http_protocols）。
    encode: Literal["data_url", "base64", "file", "url"] = "data_url"


class Inputs(_Strict):
    images: ImageInputs | None = None


class Submit(_Strict):
    path: str = Field(min_length=1, max_length=512)
    format: Literal["json", "multipart"] = "json"
    headers: dict[str, str] = Field(default_factory=dict)
    body: Any = None


class ResultSpec(_Strict):
    urls: list[str] = Field(default_factory=list, max_length=8)
    base64: list[str] = Field(default_factory=list, max_length=8)
    # hex 编码的结果（MiniMax 一类语音接口），只用于音频。
    hex: list[str] = Field(default_factory=list, max_length=8)
    error: str | None = None
    # binary：整个响应体就是结果文件。只对音频的同步接口开放（ADR-0036 2026-11-15 修订）。
    body: Literal["json", "binary"] = "json"


class VoiceOption(_Strict):
    id: str = Field(min_length=1, max_length=200)
    label: str | None = Field(default=None, max_length=40)


class Options(_Strict):
    ratio: list[str] | None = Field(default=None, min_length=1, max_length=32)
    resolution: list[str] | None = Field(default=None, min_length=1, max_length=32)
    duration: list[int] | None = Field(default=None, min_length=1, max_length=32)
    count: int = Field(default=1, ge=1, le=4)
    # 音频：音色清单（第一个是默认）、是否允许手填音色 ID、离散语速档位、输出格式、文本上限。
    voices: list[VoiceOption] | None = Field(default=None, min_length=1, max_length=64)
    custom_voice: bool = False
    speeds: list[float] | None = Field(default=None, min_length=1, max_length=16)
    formats: list[Literal["mp3", "wav", "flac", "opus", "aac"]] | None = Field(
        default=None, min_length=1, max_length=5)
    max_chars: int | None = Field(default=None, ge=1, le=20000)


class Derive(_Strict):
    source: str | list[str] = Field(alias="from")
    map: dict[str, Any] = Field(min_length=1)


class Poll(_Strict):
    path: str = Field(min_length=1, max_length=512)
    method: Literal["GET", "POST"] = "GET"
    body: Any = None
    task_id: str
    status: str
    success: list[str] = Field(min_length=1, max_length=16)
    failure: list[str] = Field(default_factory=list, max_length=16)
    interval_seconds: int = Field(default=3, ge=1, le=60)
    timeout_seconds: int | None = Field(default=None, ge=30, le=3600)
    result: ResultSpec


class CatalogKind(_Strict):
    field: str = Field(min_length=1, max_length=128)
    map: dict[str, Literal["image", "video", "text", "audio", "excluded"]] = Field(
        min_length=1, max_length=MAX_ARRAY_ITEMS)


class Catalog(_Strict):
    """目录发现：只发一次 GET，读出模型 id / 名称 / 类别。价格类字段一律不读。"""
    path: str = Field(min_length=1, max_length=512)
    items: str | None = None
    id: str = "id"
    name: str | None = None
    kind: CatalogKind | None = None


class HttpProtocol(_Strict):
    version: Literal[1]
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["image", "video", "audio"]
    auth: Auth
    submit: Submit
    inputs: Inputs = Field(default_factory=Inputs)
    options: Options = Field(default_factory=Options)
    derive: dict[str, Derive] = Field(default_factory=dict, max_length=16)
    result: ResultSpec = Field(default_factory=ResultSpec)
    poll: Poll | None = None
    catalog: Catalog | None = None


class Issue(BaseModel):
    path: str
    message: str


class ProtocolInvalidError(ValueError):
    def __init__(self, issues: list[Issue]):
        self.issues = issues
        super().__init__("；".join(f"{i.path}: {i.message}" for i in issues[:5]))


def _loc(parts: tuple | list) -> str:
    return ".".join(str(p) for p in parts) or "(根)"


def _shape_issues(value: Any, path: str = "", depth: int = 0) -> list[Issue]:
    if depth > MAX_DEPTH:
        return [Issue(path=path or "(根)", message=f"嵌套超过 {MAX_DEPTH} 层")]
    out: list[Issue] = []
    if isinstance(value, dict):
        for k, v in value.items():
            out += _shape_issues(v, f"{path}.{k}" if path else str(k), depth + 1)
    elif isinstance(value, list):
        if len(value) > MAX_ARRAY_ITEMS:
            out.append(Issue(path=path, message=f"数组超过 {MAX_ARRAY_ITEMS} 项"))
        for i, v in enumerate(value):
            out += _shape_issues(v, f"{path}.{i}", depth + 1)
    return out


def placeholders_in(value: Any, path: str) -> list[tuple[str, str, bool]]:
    """列出模板值里的占位符：(名字, 位置, 是否整值占位)。字符串里裸写的 $name 以 "$name" 返回。"""
    out: list[tuple[str, str, bool]] = []
    if isinstance(value, str):
        whole = WHOLE.match(value)
        if whole:
            return [(whole.group(1), path, True)]
        stripped = value.replace("$$", "")
        out += [(m.group(1), path, False) for m in BRACED.finditer(stripped)]
        out += [("$" + m.group(1), path, False)
                for m in _BARE.finditer(BRACED.sub("", stripped))]
    elif isinstance(value, dict):
        for k, v in value.items():
            out += placeholders_in(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            out += placeholders_in(v, f"{path}.{i}")
    return out


def _fmt(names: set[str]) -> str:
    return "、".join("${" + n + "}" for n in sorted(names)) or "（无）"


def _check_relative_path(template: str, where: str, allowed: set[str]) -> list[Issue]:
    issues: list[Issue] = []
    stripped = template.replace("$$", "")
    bare = BRACED.sub("x", stripped)
    if not template.startswith("/") or template.startswith("//"):
        issues.append(Issue(path=where, message="必须是以 / 开头的相对路径，不能写域名"))
    if any(token in bare for token in ("://", "..", "\\", "@", "#")) or re.search(r"\s", bare):
        issues.append(Issue(path=where, message="路径里不能出现 ://、..、\\、@、# 或空白"))
    for name in (m.group(1) for m in BRACED.finditer(stripped)):
        if name not in allowed:
            issues.append(Issue(path=where, message=f"路径里只能用 {_fmt(allowed)}，不能用 ${{{name}}}"))
    if _BARE.search(BRACED.sub("", stripped)):
        issues.append(Issue(path=where, message="路径里的占位符请写成 ${name}"))
    return issues


def _check_result_path(value: str, where: str) -> list[Issue]:
    if not _RESULT_PATH.match(value) or value.count(".") >= MAX_PATH_SEGMENTS:
        return [Issue(path=where,
                      message=f"取值路径写法不对（如 data.*.url，最多 {MAX_PATH_SEGMENTS} 段）")]
    return []


def _check_result(spec: ResultSpec, where: str) -> list[Issue]:
    issues = []
    if spec.body == "binary":
        if spec.urls or spec.base64 or spec.hex:
            issues.append(Issue(path=where, message="二进制响应不需要 urls / base64 / hex 路径"))
        if spec.error:
            issues += _check_result_path(spec.error, f"{where}.error")
        return issues
    if not spec.urls and not spec.base64 and not spec.hex:
        issues.append(Issue(path=where, message="至少要写一个 urls、base64 或 hex 路径"))
    for field in ("urls", "base64", "hex"):
        for i, item in enumerate(getattr(spec, field)):
            issues += _check_result_path(item, f"{where}.{field}.{i}")
    if spec.error:
        issues += _check_result_path(spec.error, f"{where}.error")
    return issues


def _catalog_issues(catalog: Catalog) -> list[Issue]:
    # 目录请求没有模型上下文：路径只能是静态的，任何占位符都不允许。
    issues = [i for i in _check_relative_path(catalog.path, "catalog.path", set())
              if "占位符" not in i.message and "只能用" not in i.message]
    if "$" in catalog.path.replace("$$", ""):
        issues.append(Issue(path="catalog.path", message="目录路径不能用占位符"))
    for field in ("items", "id", "name"):
        value = getattr(catalog, field)
        if value:
            issues += _check_result_path(value, f"catalog.{field}")
    if catalog.kind:
        issues += _check_result_path(catalog.kind.field, "catalog.kind.field")
    return issues


def used_placeholders(protocol: HttpProtocol) -> set[str]:
    """提交请求实际用到的内置占位符（含派生值的来源）。"""
    names = {n for n, _, _ in placeholders_in(protocol.submit.body, "submit.body")}
    names |= {m.group(1) for m in BRACED.finditer(protocol.submit.path)}
    for name, spec in protocol.derive.items():
        if name in names:
            names |= {spec.source} if isinstance(spec.source, str) else set(spec.source)
    return {n for n in names if n in BUILTIN_PLACEHOLDERS}


def _placeholder_issue(p: HttpProtocol, name: str, where: str, known: set[str],
                       *, in_poll: bool) -> list[Issue]:
    if name.startswith("$"):
        return [Issue(path=where,
                      message=f"字符串里的占位符请写成 ${{{name[1:]}}}，字面量 $ 写成 $$")]
    if name not in known:
        return [Issue(path=where, message=f"未知占位符 ${name}")]
    scope = BUILTIN_PLACEHOLDERS.get(name)
    if scope == "poll" and not in_poll:
        return [Issue(path=where, message="$taskId 只能用在轮询里")]
    if scope == "video" and p.kind != "video":
        return [Issue(path=where, message=f"${name} 只能用在视频接口里")]
    if scope == "audio" and p.kind != "audio":
        return [Issue(path=where, message=f"${name} 只能用在音频接口里")]
    if scope == "visual" and p.kind == "audio":
        return [Issue(path=where, message=f"音频接口不能用 ${name}")]
    return []


def _option_values(p: HttpProtocol, name: str) -> list[str] | None:
    if name == "ratio":
        return p.options.ratio
    if name == "resolution":
        return p.options.resolution
    if name == "duration":
        return None if p.options.duration is None else [str(v) for v in p.options.duration]
    if name == "n":
        return [str(v) for v in range(1, p.options.count + 1)]
    if name == "voice":
        return None if p.options.voices is None else [v.id for v in p.options.voices]
    if name == "speed":
        return None if p.options.speeds is None else [_number_text(v) for v in p.options.speeds]
    if name == "format":
        return None if p.options.formats is None else list(p.options.formats)
    if name == "instrumental":
        return ["true", "false"]
    return None


def _number_text(value: float) -> str:
    """语速 1.0 与 1 写进派生表都是 "1"：派生键与运行时取值用同一种写法。"""
    return str(int(value)) if float(value).is_integer() else str(value)


def _derive_issues(p: HttpProtocol) -> list[Issue]:
    issues: list[Issue] = []
    for name, spec in p.derive.items():
        where = f"derive.{name}"
        if not _NAME.match(name) or name in BUILTIN_PLACEHOLDERS:
            issues.append(Issue(path=where,
                                message="派生值名称须是字母开头的标识符，且不能与内置占位符同名"))
        sources = [spec.source] if isinstance(spec.source, str) else spec.source
        if not 1 <= len(sources) <= 2:
            issues.append(Issue(path=f"{where}.from", message="from 只能写一个或两个占位符"))
            continue
        if any(source not in DERIVABLE for source in sources):
            issues.append(Issue(path=f"{where}.from",
                                message=f"只能从 {'、'.join(sorted(DERIVABLE))} 派生"))
            continue
        if "model" in sources:
            continue  # 模型 id 不可枚举，查不到时该键省略。
        value_lists = [_option_values(p, s) for s in sources]
        if any(v is None for v in value_lists):
            issues.append(Issue(path=f"{where}.from", message="派生来源必须在 options 里列出可选值"))
            continue
        combos = [""]
        for values in value_lists:
            combos = [f"{c}@{v}" if c else v for c in combos for v in values or []]
        missing = [c for c in combos if c not in spec.map]
        if missing:
            issues.append(Issue(path=f"{where}.map", message=f"缺少 {'、'.join(missing[:6])} 的对应值"))
    return issues


def _auth_issues(p: HttpProtocol) -> list[Issue]:
    issues = []
    if p.auth.type in ("header", "query"):
        if not p.auth.name or not _HEADER_NAME.match(p.auth.name):
            issues.append(Issue(path="auth.name", message="header / query 鉴权必须写密钥字段名"))
        elif p.auth.type == "header" and p.auth.name.lower() in FORBIDDEN_HEADERS - {"authorization"}:
            issues.append(Issue(path="auth.name", message=f"不能用 {p.auth.name} 传密钥"))
    elif p.auth.name is not None:
        issues.append(Issue(path="auth.name", message="只有 header / query 鉴权需要 name"))
    if p.auth.prefix is not None and p.auth.type != "header":
        issues.append(Issue(path="auth.prefix", message="只有 header 鉴权可以带前缀"))
    if p.auth.prefix and _CONTROL.search(p.auth.prefix):
        issues.append(Issue(path="auth.prefix", message="前缀里不能有换行或控制字符"))
    for name, value in p.submit.headers.items():
        low = name.lower()
        where = f"submit.headers.{name}"
        if not _HEADER_NAME.match(name):
            issues.append(Issue(path=where, message="请求头名称不合法"))
        elif low in FORBIDDEN_HEADERS or (p.auth.name and low == p.auth.name.lower()):
            issues.append(Issue(path=where, message="这个请求头由系统负责，不能写死"))
        if "$" in value.replace("$$", ""):
            issues.append(Issue(path=where, message="请求头里不能用占位符"))
        if _CONTROL.search(value):
            issues.append(Issue(path=where, message="请求头的值不能有换行或控制字符"))
    return issues


def _poll_issues(p: HttpProtocol, known: set[str]) -> list[Issue]:
    assert p.poll is not None
    issues = []
    poll_names = placeholders_in(p.poll.body, "poll.body")
    for name, where, _ in poll_names:
        issues += _placeholder_issue(p, name, where, known | {"taskId"}, in_poll=True)
    issues += _check_relative_path(p.poll.path, "poll.path", {"taskId", "model"})
    if "${taskId}" not in p.poll.path and not any(n == "taskId" for n, _, _ in poll_names):
        issues.append(Issue(path="poll.path", message="轮询地址或正文必须用到 taskId"))
    if p.poll.method == "GET" and p.poll.body is not None:
        issues.append(Issue(path="poll.body", message="GET 轮询不能带正文"))
    for field in ("task_id", "status"):
        issues += _check_result_path(getattr(p.poll, field), f"poll.{field}")
    issues += _check_result(p.poll.result, "poll.result")
    overlap = {s.lower() for s in p.poll.success} & {s.lower() for s in p.poll.failure}
    if overlap:
        issues.append(Issue(path="poll.failure",
                            message=f"{'、'.join(sorted(overlap))} 同时出现在成功与失败里"))
    return issues


def _option_issues(p: HttpProtocol, used: set[str]) -> list[Issue]:
    issues = []
    for name, option in (("ratio", p.options.ratio), ("resolution", p.options.resolution),
                         ("duration", p.options.duration), ("durationText", p.options.duration)):
        if name in used and option is None:
            key = "duration" if name == "durationText" else name
            issues.append(Issue(path=f"options.{key}",
                                message=f"用到 ${name} 必须在 options.{key} 列出可选值"))
    if p.options.count > 1 and "n" not in used:
        issues.append(Issue(path="options.count",
                            message="一次出多张必须在正文里用 $n（不支持循环多次提交）"))
    if p.kind == "video" and p.options.count != 1:
        issues.append(Issue(path="options.count", message="视频接口一次只出一条"))
    issues += _audio_option_issues(p, used)
    return issues


def _audio_option_issues(p: HttpProtocol, used: set[str]) -> list[Issue]:
    o = p.options
    declared = {"voices": o.voices, "speeds": o.speeds, "formats": o.formats,
                "max_chars": o.max_chars, "custom_voice": o.custom_voice or None}
    if p.kind != "audio":
        return [Issue(path=f"options.{name}", message="只有音频接口能声明这一项")
                for name, value in declared.items() if value is not None]
    issues = []
    for name, option in (("voice", "voices"), ("speed", "speeds"), ("format", "formats")):
        if name in used and declared[option] is None:
            issues.append(Issue(path=f"options.{option}",
                                message=f"用到 ${name} 必须在 options.{option} 列出可选值"))
    if o.custom_voice and "voice" not in used:
        issues.append(Issue(path="options.custom_voice", message="允许自定义音色必须在正文里用到 $voice"))
    if o.speeds is not None and any(not 0.25 <= v <= 4 for v in o.speeds):
        issues.append(Issue(path="options.speeds", message="语速档位要在 0.25–4 之间"))
    if o.voices is not None and len({v.id for v in o.voices}) != len(o.voices):
        issues.append(Issue(path="options.voices", message="音色 id 不能重复"))
    music = bool(used & MUSIC_PLACEHOLDERS)
    if o.count > (AUDIO_MAX_COUNT if music else 1):
        issues.append(Issue(path="options.count",
                            message=f"音乐一次最多 {AUDIO_MAX_COUNT} 条" if music else "语音一次只出一条"))
    return issues


def _image_issues(p: HttpProtocol, used: set[str],
                  body_names: list[tuple[str, str, bool]]) -> list[Issue]:
    issues = []
    uses_images = bool(used & IMAGE_PLACEHOLDERS)
    if uses_images and p.inputs.images is None:
        issues.append(Issue(path="inputs.images", message="用到参考图占位符必须声明 inputs.images"))
    if p.inputs.images is not None and not uses_images:
        issues.append(Issue(path="inputs.images", message="声明了参考图但正文没有用到"))
    if p.inputs.images and p.inputs.images.encode == "file":
        if p.submit.format != "multipart":
            issues.append(Issue(path="inputs.images.encode", message="file 只能用于 multipart"))
        for name, where, whole in body_names:
            if name in IMAGE_PLACEHOLDERS and (not whole or where.count(".") != 2):
                issues.append(Issue(path=where, message="文件上传的参考图必须是表单顶层字段的整值"))
    return issues


def _body_issues(p: HttpProtocol) -> list[Issue]:
    body = p.submit.body
    if p.submit.format == "multipart":
        if not isinstance(body, dict) or not body:
            return [Issue(path="submit.body", message="multipart 正文必须是非空对象")]
        return [Issue(path=f"submit.body.{key}", message="multipart 字段只能是单值或占位符")
                for key, value in body.items() if isinstance(value, (dict, list))]
    if body is not None and not isinstance(body, (dict, list)):
        return [Issue(path="submit.body", message="JSON 正文必须是对象或数组")]
    return []


def _binary_issues(p: HttpProtocol) -> list[Issue]:
    """二进制响应与 hex 只对音频放开；二进制还要求同步（ADR-0036 2026-11-15 修订）。"""
    issues = []
    if p.result.body == "binary":
        if p.kind != "audio":
            issues.append(Issue(path="result.body", message="二进制响应只用于音频接口"))
        if p.poll is not None:
            issues.append(Issue(path="result.body", message="二进制响应只用于同步接口（不能配 poll）"))
    if p.poll is not None and p.poll.result.body == "binary":
        issues.append(Issue(path="poll.result.body", message="轮询结果只能是 JSON"))
    specs = [("result", p.result)] + ([("poll.result", p.poll.result)] if p.poll else [])
    for where, spec in specs:
        if spec.hex and p.kind != "audio":
            issues.append(Issue(path=f"{where}.hex", message="hex 结果只用于音频接口"))
    return issues


def _semantic_issues(p: HttpProtocol) -> list[Issue]:
    known = set(BUILTIN_PLACEHOLDERS) | set(p.derive)
    body_names = placeholders_in(p.submit.body, "submit.body")
    issues = _auth_issues(p)
    issues += _check_relative_path(p.submit.path, "submit.path", {"model"})
    issues += _derive_issues(p)
    for name, where, _ in body_names:
        issues += _placeholder_issue(p, name, where, known, in_poll=False)
    if p.poll is not None:
        issues += _poll_issues(p, known)
    else:
        issues += _check_result(p.result, "result")
    if p.poll is not None and p.result.error:
        issues += _check_result_path(p.result.error, "result.error")
    issues += _binary_issues(p)
    used = used_placeholders(p)
    issues += _option_issues(p, used)
    issues += _image_issues(p, used, body_names)
    issues += _body_issues(p)
    if p.catalog is not None:
        issues += _catalog_issues(p.catalog)
    return issues


def _pydantic_message(error: dict) -> str:
    kind = error.get("type", "")
    if kind == "missing":
        return "缺少必填项"
    if kind == "extra_forbidden":
        return "不认识的字段"
    if kind == "literal_error":
        return f"取值不在允许范围内：{error.get('ctx', {}).get('expected', '')}"
    return str(error.get("msg", "格式不对"))


def parse_protocol(document: Any) -> HttpProtocol:
    """完整校验：结构 + 语义。失败抛 ProtocolInvalidError（带逐条位置）。"""
    if not isinstance(document, dict):
        raise ProtocolInvalidError([Issue(path="(根)", message="模板必须是 JSON 对象")])
    if len(json.dumps(document, ensure_ascii=False).encode()) > MAX_DOCUMENT_BYTES:
        raise ProtocolInvalidError([Issue(path="(根)", message="模板超过 64 KB")])
    shape = _shape_issues(document)
    if shape:
        raise ProtocolInvalidError(shape)
    if document.get("version") != PROTOCOL_VERSION:
        raise ProtocolInvalidError([Issue(path="version", message="只支持 version 1")])
    try:
        protocol = HttpProtocol.model_validate(document)
    except ValidationError as error:
        raise ProtocolInvalidError([
            Issue(path=_loc(e["loc"]), message=_pydantic_message(e)) for e in error.errors()
        ]) from None
    issues = _semantic_issues(protocol)
    if issues:
        raise ProtocolInvalidError(issues)
    return protocol


def declared_capabilities(protocol: HttpProtocol) -> dict[str, Any]:
    """前后端共用的能力声明：控件只显示这里有的，提交时后端按同一份再校验。"""
    used = used_placeholders(protocol)
    limit = protocol.inputs.images.max if protocol.inputs.images else 0
    if "images" in used:
        reference = limit
    elif "image" in used:
        reference = min(limit, 1)
    else:
        reference = 0
    if protocol.kind == "audio":
        return _audio_capabilities(protocol, used)
    return {
        "kind": protocol.kind,
        "ratios": protocol.options.ratio if "ratio" in used else None,
        "resolutions": protocol.options.resolution if "resolution" in used else None,
        "durations": (protocol.options.duration
                      if used & {"duration", "durationText"} else None),
        "max_count": protocol.options.count if "n" in used else 1,
        "reference_images": reference,
        "frames": 2 if "lastFrame" in used else 1 if "firstFrame" in used else 0,
    }


def _audio_capabilities(protocol: HttpProtocol, used: set[str]) -> dict[str, Any]:
    """音频的能力声明：没用到的控件给 null / false，界面不显示，提交时也不接受。"""
    o = protocol.options
    music = bool(used & MUSIC_PLACEHOLDERS)
    return {
        "kind": "audio",
        "family": "music" if music else "speech",
        "ratios": None, "resolutions": None, "durations": None,
        "max_count": o.count if "n" in used else 1,
        "reference_images": 0, "frames": 0,
        "voices": ([{"id": v.id, "label": v.label or v.id} for v in o.voices]
                   if "voice" in used and o.voices else None),
        "custom_voice": bool(o.custom_voice and "voice" in used),
        "speeds": list(o.speeds) if "speed" in used and o.speeds else None,
        "formats": list(o.formats) if "format" in used and o.formats else None,
        "max_chars": o.max_chars,
        "lyrics": "lyrics" in used,
        "instrumental": "instrumental" in used,
    }
