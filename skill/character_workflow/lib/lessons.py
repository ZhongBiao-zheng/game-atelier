"""Memory 追加 helper —— 三 scope(global / workspace / project)。

§11.7 单画师 + 单进程假设:一条经验 < 4096 字节(PIPE_BUF),
单行 `open("a")` 是原子的。

scope:
- "global"     → ~/.claude/MEMORY.md 下 `## Skills Memory > ### character-workflow > #### {Kind}` section
- "workspace"  → 仓库根 MEMORY.md 下 `## character-workflow > ### {Kind}` section
- "project"    → projects/<slug>/MEMORY.md 下 `## character-workflow > ### {Kind}` section

不存在的 section header 会被自动建。

旧 `append_lesson(kind, line)` 保留作 alias —— 默认 `scope="project"` +
从 active-character.json → projects.json::assignments 解析 slug;未归属抛 ValueError。
"""
from __future__ import annotations

import os
import re
from pathlib import Path


VALID_KINDS = ("portrait", "promo", "turnaround")
VALID_SCOPES = ("global", "workspace", "project")

_KIND_TITLE = {"portrait": "Portrait", "promo": "Promo", "turnaround": "Turnaround"}


def _project_root() -> Path:
    return Path(os.environ.get("PROJECT_ROOT", Path.cwd()))


def _global_memory_path() -> Path:
    return Path(os.environ.get("HOME", "~")).expanduser() / ".claude" / "MEMORY.md"


def _workspace_memory_path() -> Path:
    return _project_root() / "MEMORY.md"


def _project_memory_path(slug: str) -> Path:
    return _project_root() / "projects" / slug / "MEMORY.md"


def _resolve_memory_path(scope: str, project_slug: str | None) -> Path:
    if scope == "global":
        return _global_memory_path()
    if scope == "workspace":
        return _workspace_memory_path()
    if scope == "project":
        if not project_slug:
            raise ValueError("project_slug required for scope=project")
        return _project_memory_path(project_slug)
    raise ValueError(f"unknown scope: {scope!r}, expected one of {VALID_SCOPES}")


def _section_headers(scope: str, kind: str) -> list[str]:
    """返回需要存在的 header 链(从外到内)。"""
    kind_title = _KIND_TITLE[kind]
    if scope == "global":
        return ["## Skills Memory", "### character-workflow", f"#### {kind_title}"]
    return ["## character-workflow", f"### {kind_title}"]


def _ensure_section(path: Path, headers: list[str]) -> None:
    """确保 MEMORY.md 存在,且 headers 链路完整。缺啥补啥到文件末尾。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("# MEMORY\n\n", encoding="utf-8")
    text = path.read_text(encoding="utf-8")
    for header in headers:
        if not re.search(rf'^{re.escape(header)}\s*$', text, re.MULTILINE):
            text = text.rstrip() + f"\n\n{header}\n"
    path.write_text(text, encoding="utf-8")


def _insert_under_header(path: Path, last_header: str, line: str) -> None:
    """在 last_header 这个 section 末尾(下一个同级或更高级 header 之前)追加 line。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    header_depth = len(last_header) - len(last_header.lstrip("#"))

    try:
        start = lines.index(last_header)
    except ValueError:
        # _ensure_section 应该保证有,fallback 直接末尾追加
        path.write_text(text.rstrip() + f"\n{last_header}\n{line}\n", encoding="utf-8")
        return

    # 找下一个同级或更高级 header
    end = len(lines)
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= header_depth:
                end = i
                break

    # 在 end 之前插入 line(空行兼容)
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    lines.insert(end, line)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_memory(
    *,
    kind: str,
    line: str,
    scope: str = "project",
    project_slug: str | None = None,
) -> Path:
    """追加一条经验到对应 scope 的 MEMORY.md 指定 kind section。

    line 必须单行,< 4000 字节,符合 PIPE_BUF 单行原子写入边界。
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}, expected one of {VALID_KINDS}")
    if "\n" in line or "\r" in line:
        raise ValueError("memory line must be single-line (no newline allowed)")
    if len(line.encode("utf-8")) >= 4000:
        raise ValueError(f"memory line too long: {len(line.encode('utf-8'))} bytes (limit 4000)")

    path = _resolve_memory_path(scope, project_slug)
    headers = _section_headers(scope, kind)
    _ensure_section(path, headers)
    _insert_under_header(path, headers[-1], line)
    return path


# ---------- 兼容旧 API ----------


def _lessons_path(kind: str) -> Path:
    """旧 API:回到 references/lessons/<kind>.md。
    保留给老测试 / append_lesson alias 用。
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}, expected one of {VALID_KINDS}")
    skill_root = Path(__file__).resolve().parent.parent
    return skill_root / "references" / "lessons" / f"{kind}.md"


def append_lesson(kind: str, line: str) -> Path:
    """Deprecated alias —— 等价于 `append_memory(scope="project", project_slug=<active>)`。
    解析 active_id → assignments → slug;未归属抛 ValueError 让上层捕获 + 退出码 2。
    """
    from skill.character_workflow.lib.active_character import read_active
    from skill.character_workflow.lib.projects import read_projects

    active = read_active()
    if not active.active_id:
        raise ValueError("append_lesson: no active character; use append_memory --scope workspace")
    pf = read_projects()
    project_id = pf.assignments.get(active.active_id)
    if not project_id:
        raise ValueError(
            f"append_lesson: character {active.active_id!r} not assigned to any project; "
            "use append_memory --scope workspace or run assign-character first"
        )
    project = next((p for p in pf.projects if p.id == project_id), None)
    if not project:
        raise ValueError(f"append_lesson: project {project_id!r} not found in projects.json")
    return append_memory(kind=kind, line=line, scope="project", project_slug=project.slug)
