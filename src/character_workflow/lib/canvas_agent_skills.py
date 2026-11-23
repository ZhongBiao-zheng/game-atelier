"""画布 Agent 的 Skill：Agent Skills 标准文件夹（SKILL.md + 参考文件），存在 <data_root>/agent-skills/。

- 导入：zip、文件夹（浏览器传来的相对路径 + 文件）、或单个 SKILL.md；名称取 frontmatter 的 name。
- Agent 只读：列表进 system prompt（名称 + 描述），正文与附带文件经 load_skill / read_skill_file 读。
- 不执行任何脚本：导入时检测到 scripts/ 或脚本文件只标记 has_scripts，面板据此提示。
- 解包的路径闸门：拒绝绝对路径、盘符、..、符号链接条目；同名比较一律 casefold（APFS 大小写不敏感）。
"""
from __future__ import annotations

import io
import logging
import re
import shutil
import stat
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import yaml

from character_workflow.lib import data_root
from character_workflow.lib.canvas_tool_common import CanvasToolError

BUILTIN_ROOT = Path(__file__).resolve().parents[1] / "agent_skills"
PROMPT_LIMIT = 4000
SKILL_FILE = "SKILL.md"
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MAX_FILES = 500
MAX_READ_CHARS = 60_000
SCRIPT_SUFFIXES = frozenset({".py", ".sh", ".js", ".ts", ".rb", ".ps1", ".bat", ".cmd", ".exe"})
IGNORED_NAMES = frozenset({".ds_store", "thumbs.db"})
_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)
TOO_LARGE = "Skill 太大（上限 20MB / 500 个文件）"


@dataclass(frozen=True)
class SkillInfo:
    name: str
    description: str
    has_scripts: bool
    builtin: bool

    def as_dict(self) -> dict:
        return {"name": self.name, "description": self.description,
                "has_scripts": self.has_scripts, "builtin": self.builtin}


def skills_dir() -> Path:
    return data_root.resolve_data_root() / "agent-skills"


def parse_skill_md(text: str) -> tuple[dict, str]:
    """(frontmatter, body). Raises CanvasToolError if the frontmatter is missing or malformed."""
    text = text.lstrip("﻿")
    match = _FRONTMATTER.match(text)
    if match is None:
        raise CanvasToolError("INVALID_PARAMETERS",
                            "SKILL.md 开头缺少用 --- 包起来的 name / description", 422)
    try:
        meta = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        raise CanvasToolError("INVALID_PARAMETERS", "SKILL.md 的 frontmatter 不是合法的 YAML", 422) from None
    if not isinstance(meta, dict):
        raise CanvasToolError("INVALID_PARAMETERS", "SKILL.md 的 frontmatter 格式不对", 422)
    return meta, text[match.end():]


def _normalize_name(raw: object) -> str:
    name = str(raw or "").strip().lower().replace("_", "-").replace(" ", "-")
    if not NAME_PATTERN.fullmatch(name):
        raise CanvasToolError("INVALID_PARAMETERS",
                            "Skill 名称只能用小写字母、数字和短横线（最多 64 个字符）", 422)
    return name


def clean_relative(raw: str) -> str:
    """相对 posix 路径；Windows 打的 zip 可能用反斜杠，先统一再判。"""
    path = raw.replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise CanvasToolError("INVALID_PARAMETERS", f"不允许的路径 {raw}", 422)
    parts = [part for part in path.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        raise CanvasToolError("INVALID_PARAMETERS", f"不允许的路径 {raw}", 422)
    return "/".join(parts)


def _has_scripts(paths: list[str]) -> bool:
    return any(
        PurePosixPath(path).parts[0].casefold() == "scripts"
        or PurePosixPath(path).suffix.casefold() in SCRIPT_SUFFIXES
        for path in paths
    )


def _info(directory: Path) -> SkillInfo | None:
    skill_md = directory / SKILL_FILE
    if not skill_md.is_file():
        return None
    try:
        meta, _ = parse_skill_md(skill_md.read_text(encoding="utf-8"))
    except (CanvasToolError, OSError, UnicodeDecodeError):
        return None
    files = [p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()]
    return SkillInfo(name=directory.name, description=str(meta.get("description") or "").strip(),
                     has_scripts=_has_scripts(files), builtin=directory.parent == BUILTIN_ROOT)


def list_skills() -> list[SkillInfo]:
    rows = {}
    for root in (BUILTIN_ROOT, skills_dir()):
        if root.is_dir():
            for path in sorted(root.iterdir()):
                if NAME_PATTERN.fullmatch(path.name) and path.name not in rows:
                    if info := _info(path):
                        rows[path.name] = info
    return list(rows.values())


def _skill_path(name: str) -> Path:
    if not NAME_PATTERN.fullmatch(name or ""):
        raise CanvasToolError("INVALID_TARGET", f"没有名为 {name} 的 Skill", 404)
    if (BUILTIN_ROOT / name / SKILL_FILE).is_file():
        return BUILTIN_ROOT / name
    path = skills_dir() / name
    if not (path / SKILL_FILE).is_file():
        raise CanvasToolError("INVALID_TARGET", f"没有名为 {name} 的 Skill", 404)
    return path


def read_skill(name: str) -> str:
    """SKILL.md 正文（不含 frontmatter）+ 附带文件清单，模型按需继续读。"""
    path = _skill_path(name)
    _, body = parse_skill_md((path / SKILL_FILE).read_text(encoding="utf-8"))
    extra = sorted(p.relative_to(path).as_posix() for p in path.rglob("*")
                   if p.is_file() and p.name != SKILL_FILE)
    listing = ("\n\n附带文件（用 read_skill_file 读取）：\n" + "\n".join(f"- {p}" for p in extra)
               if extra else "")
    return body.strip()[:MAX_READ_CHARS] + listing


def read_skill_file(name: str, relative: str) -> str:
    root = _skill_path(name).resolve()
    target = (root / clean_relative(relative)).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise CanvasToolError("INVALID_TARGET", f"Skill {name} 里没有文件 {relative}", 404)
    try:
        return target.read_bytes().decode("utf-8")[:MAX_READ_CHARS]
    except UnicodeDecodeError:
        raise CanvasToolError("INVALID_PARAMETERS", "只能读取文本文件", 422) from None


def _strip_common_root(files: dict[str, bytes]) -> dict[str, bytes]:
    """zip / 文件夹常多套一层目录（my-skill/SKILL.md）：以最浅的 SKILL.md 所在目录为根。"""
    candidates = sorted((p for p in files if PurePosixPath(p).name == SKILL_FILE),
                        key=lambda p: len(PurePosixPath(p).parts))
    if not candidates:
        raise CanvasToolError("INVALID_PARAMETERS", "没有找到 SKILL.md", 422)
    root = PurePosixPath(candidates[0]).parent.as_posix()
    if root == ".":
        return files
    prefix = f"{root}/"
    return {p[len(prefix):]: data for p, data in files.items() if p.startswith(prefix)}


def files_from_zip(payload: bytes) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        raise CanvasToolError("INVALID_PARAMETERS", "不是有效的 zip 文件", 422) from None
    files: dict[str, bytes] = {}
    total = 0
    with archive:
        for entry in archive.infolist():
            if entry.is_dir() or entry.filename.startswith("__MACOSX/"):
                continue
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise CanvasToolError("INVALID_PARAMETERS", f"zip 里有符号链接 {entry.filename}", 422)
            total += entry.file_size  # 先按声明大小拦，再按实际读出的字节数拦（防 zip 炸弹）
            if total > MAX_TOTAL_BYTES or len(files) >= MAX_FILES:
                raise CanvasToolError("CONTENT_TOO_LARGE", TOO_LARGE, 413)
            with archive.open(entry) as handle:
                data = handle.read(MAX_TOTAL_BYTES + 1)
            if len(data) > entry.file_size:
                raise CanvasToolError("CONTENT_TOO_LARGE", TOO_LARGE, 413)
            files[clean_relative(entry.filename)] = data
    return files


def install_skill(files: dict[str, bytes], *, replace: bool = False) -> SkillInfo:
    """Validate and atomically write a skill; files are {relative path: bytes}."""
    cleaned = {
        clean_relative(raw): data for raw, data in files.items()
        if PurePosixPath(raw.replace("\\", "/")).name.casefold() not in IGNORED_NAMES
        and not raw.replace("\\", "/").startswith("__MACOSX/")
    }
    if len(cleaned) > MAX_FILES or sum(len(d) for d in cleaned.values()) > MAX_TOTAL_BYTES:
        raise CanvasToolError("CONTENT_TOO_LARGE", TOO_LARGE, 413)
    cleaned = _strip_common_root(cleaned)
    # 大小写不敏感的文件系统上 Readme.md 与 README.md 会写到同一个文件。
    if len({path.casefold() for path in cleaned}) != len(cleaned):
        raise CanvasToolError("INVALID_PARAMETERS", "有只差大小写的同名文件", 422)
    try:
        meta, _ = parse_skill_md(cleaned[SKILL_FILE].decode("utf-8"))
    except UnicodeDecodeError:
        raise CanvasToolError("INVALID_PARAMETERS", "SKILL.md 不是 UTF-8 文本", 422) from None
    name = _normalize_name(meta.get("name"))
    if not str(meta.get("description") or "").strip():
        raise CanvasToolError("INVALID_PARAMETERS", "SKILL.md 缺少 description", 422)

    if (BUILTIN_ROOT / name / SKILL_FILE).is_file():
        raise CanvasToolError("BUILTIN_SKILL", f"{name} 是内置 Skill，请改名后导入", 422)
    root = skills_dir()
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    if target.exists() and not replace:
        raise CanvasToolError("SKILL_EXISTS", f"已经有名为 {name} 的 Skill", 409)
    staging = root / f".import-{uuid.uuid4().hex}"
    try:
        for path, data in cleaned.items():
            destination = staging / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    info = _info(target)
    if info is None:  # pragma: no cover - 刚校验过 SKILL.md
        raise CanvasToolError("INVALID_PARAMETERS", "SKILL.md 无法读取", 422)
    return info


def delete_skill(name: str) -> None:
    path = _skill_path(name)
    if path.parent == BUILTIN_ROOT:
        raise CanvasToolError("BUILTIN_SKILL", "内置 Skill 不能删除", 403)
    shutil.rmtree(path)


def skills_prompt() -> str:
    """System prompt 里的 Skill 目录：只有名称和描述，正文按需加载。"""
    skills = list_skills()
    if not skills:
        return ""
    header = "\n\n可用的 Skill（做法说明）。用 load_skill 按名称读取，只参考文字，不执行脚本：\n"
    remaining = PROMPT_LIMIT - len(header) - sum(len(s.name) + 4 for s in skills)
    width = max(0, remaining // len(skills))
    shorten = sum(len(s.description) for s in skills) > remaining
    if shorten:
        logging.getLogger(__name__).warning("Skill 目录过长，已缩短描述")
    lines = [f"- {s.name}：{s.description[:width] if shorten else s.description}" for s in skills]
    catalog = header + "\n".join(lines)
    if len(catalog) > PROMPT_LIMIT:
        end = catalog.rfind("\n", 0, PROMPT_LIMIT - 35)
        catalog = catalog[:end] + f"\n（共 {len(skills)} 个 Skill，目录长度已达上限）"
    return catalog


def load_skills(names: list[str]) -> dict:
    if not isinstance(names, list) or not 1 <= len(names) <= 3 or not all(
        isinstance(name, str) for name in names
    ):
        raise CanvasToolError("INVALID_PARAMETERS", "names 需要 1 到 3 个 Skill 名称", 422)
    entries = []
    for name in names:
        try:
            content = read_skill(name)
        except (CanvasToolError, UnicodeError, OSError) as error:
            entries.append({"name": name, "error": str(error)})
        else:
            entries.append({"name": name, "content": f'<skill name="{name}">\n{content}\n</skill>'})
    return {"skills": entries}


def selected_skill_prompt(name: str) -> str:
    return f"[本轮按 Skill「{name}」的说明来做；其中提到的脚本不能执行]\n{read_skill(name)}"
