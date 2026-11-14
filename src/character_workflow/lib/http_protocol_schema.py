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

# 内置占位符 → 可用范围。taskId 只在轮询里有意义；时长与首尾帧只对视频有意义。
BUILTIN_PLACEHOLDERS: dict[str, str] = {
    "prompt": "any", "model": "any", "n": "any", "ratio": "any", "resolution": "any",
    "duration": "video", "durationText": "video", "images": "any", "image": "any",
    "firstFrame": "video", "lastFrame": "video", "taskId": "poll",
}
IMAGE_PLACEHOLDERS = frozenset({"images", "image", "firstFrame", "lastFrame"})
# 派生值只能从这些单值占位符换算。
DERIVABLE = frozenset({"ratio", "resolution", "duration", "n", "model"})
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
    encode: Literal["data_url", "base64", "file"] = "data_url"


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
    error: str | None = None


class Options(_Strict):
    ratio: list[str] | None = Field(default=None, min_length=1, max_length=32)
    resolution: list[str] | None = Field(default=None, min_length=1, max_length=32)
    duration: list[int] | None = Field(default=None, min_length=1, max_length=32)
    count: int = Field(default=1, ge=1, le=4)


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


class HttpProtocol(_Strict):
    version: Literal[1]
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["image", "video"]
    auth: Auth
    submit: Submit
    inputs: Inputs = Field(default_factory=Inputs)
    options: Options = Field(default_factory=Options)
    derive: dict[str, Derive] = Field(default_factory=dict, max_length=16)
    result: ResultSpec = Field(default_factory=ResultSpec)
    poll: Poll | None = None
    # 保留给「目录发现」：版本 1 只接受、不解析。
    catalog: Any = None


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
    if not spec.urls and not spec.base64:
        issues.append(Issue(path=where, message="至少要写一个 urls 或 base64 路径"))
    for field in ("urls", "base64"):
        for i, item in enumerate(getattr(spec, field)):
            issues += _check_result_path(item, f"{where}.{field}.{i}")
    if spec.error:
        issues += _check_result_path(spec.error, f"{where}.error")
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
    return None


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
    used = used_placeholders(p)
    issues += _option_issues(p, used)
    issues += _image_issues(p, used, body_names)
    issues += _body_issues(p)
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
