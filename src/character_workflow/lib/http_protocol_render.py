"""接口模板的渲染与取值：纯函数，不发请求、不读文件。

- 整值占位 `"$name"`：替换成带类型的值；取不到值时整个键（或数组元素）删除。
- 内插 `"${name}"`：按文本拼接；任何一个取不到值，整个字符串视为取不到。
- `$$` 是字面量 `$`。
- 取值路径：点分，`*` 遍历数组，数字是下标，如 `data.*.url`。
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from character_workflow.lib.http_protocol_schema import BRACED, WHOLE, Derive

MISSING: Any = object()


def render(template: Any, context: dict[str, Any]) -> Any:
    if isinstance(template, str):
        return _render_string(template, context)
    if isinstance(template, dict):
        out = {}
        for key, value in template.items():
            rendered = render(value, context)
            if rendered is not MISSING:
                out[key] = rendered
        return out
    if isinstance(template, list):
        return [item for item in (render(v, context) for v in template) if item is not MISSING]
    return template


def _render_string(value: str, context: dict[str, Any]) -> Any:
    whole = WHOLE.match(value)
    if whole:
        found = context.get(whole.group(1))
        return MISSING if found is None else found
    missing = False

    def substitute(match) -> str:
        nonlocal missing
        found = context.get(match.group(1))
        if found is None:
            missing = True
            return ""
        return str(found)

    rendered = "$".join(BRACED.sub(substitute, part) for part in value.split("$$"))
    return MISSING if missing else rendered


def render_path(template: str, context: dict[str, Any]) -> str:
    """地址模板只允许 ${name}；值按路径段编码，不能借值注入 / ? # 改写目标。"""
    def substitute(match) -> str:
        found = context.get(match.group(1))
        if found is None:
            raise ValueError(f"地址里的 ${{{match.group(1)}}} 没有值")
        return quote(str(found), safe="")

    return "$".join(BRACED.sub(substitute, part) for part in template.split("$$"))


def derive_values(derive: dict[str, Derive], context: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, spec in derive.items():
        sources = [spec.source] if isinstance(spec.source, str) else spec.source
        values = [context.get(source) for source in sources]
        if any(v is None for v in values):
            continue
        key = "@".join(str(v) for v in values)
        if key in spec.map:
            out[name] = spec.map[key]
    return out


def resolve_path(data: Any, path: str) -> list[Any]:
    current = [data]
    for segment in path.split("."):
        nxt: list[Any] = []
        for item in current:
            if segment == "*":
                if isinstance(item, list):
                    nxt.extend(item)
            elif isinstance(item, list) and segment.isdigit():
                index = int(segment)
                if index < len(item):
                    nxt.append(item[index])
            elif isinstance(item, dict) and segment in item:
                nxt.append(item[segment])
        current = nxt
    return [item for item in current if item is not None]


def first_value(data: Any, path: str | None) -> Any:
    if not path:
        return None
    found = resolve_path(data, path)
    return found[0] if found else None


def strings_at(data: Any, paths: list[str]) -> list[str]:
    out: list[str] = []
    for path in paths:
        for item in resolve_path(data, path):
            if isinstance(item, str) and item and item not in out:
                out.append(item)
    return out
