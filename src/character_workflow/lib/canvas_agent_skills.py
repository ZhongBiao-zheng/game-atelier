"""画布 Agent 的 Skill：Agent Skills 标准文件夹（SKILL.md + 参考文件），存在 <data_root>/agent-skills/。

- 导入：zip、文件夹（浏览器传来的相对路径 + 文件）、或单个 SKILL.md；名称取 frontmatter 的 name。
- Agent 只读：列表进 system prompt（名称 + 描述），正文与附带文件经 load_skill / read_skill_file 读。
- 不执行任何脚本：导入时检测到 scripts/ 或脚本文件只标记 has_scripts，面板据此提示。
- 解包的路径闸门：拒绝绝对路径、盘符、..、符号链接条目；同名比较一律 casefold（APFS 大小写不敏感）。
"""
from __future__ import annotations

import io
import re
import shutil
import stat
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import yaml

from character_workflow.lib import data_root
from character_workflow.lib.workshop import WorkshopError

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

    def as_dict(self) -> dict:
        return {"name": self.name, "description": self.description,
                "has_scripts": self.has_scripts}


def skills_dir() -> Path:
    return data_root.resolve_data_root() / "agent-skills"


def parse_skill_md(text: str) -> tuple[dict, str]:
    """(frontmatter, body). Raises WorkshopError if the frontmatter is missing or malformed."""
    text = text.lstrip("﻿")
    match = _FRONTMATTER.match(text)
    if match is None:
        raise WorkshopError("INVALID_PARAMETERS",
                            "SKILL.md 开头缺少用 --- 包起来的 name / description", 422)
    try:
        meta = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        raise WorkshopError("INVALID_PARAMETERS", "SKILL.md 的 frontmatter 不是合法的 YAML", 422) from None
    if not isinstance(meta, dict):
        raise WorkshopError("INVALID_PARAMETERS", "SKILL.md 的 frontmatter 格式不对", 422)
    return meta, text[match.end():]


def _normalize_name(raw: object) -> str:
    name = str(raw or "").strip().lower().replace("_", "-").replace(" ", "-")
    if not NAME_PATTERN.fullmatch(name):
        raise WorkshopError("INVALID_PARAMETERS",
                            "Skill 名称只能用小写字母、数字和短横线（最多 64 个字符）", 422)
    return name


def clean_relative(raw: str) -> str:
    """相对 posix 路径；Windows 打的 zip 可能用反斜杠，先统一再判。"""
    path = raw.replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise WorkshopError("INVALID_PARAMETERS", f"不允许的路径 {raw}", 422)
    parts = [part for part in path.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        raise WorkshopError("INVALID_PARAMETERS", f"不允许的路径 {raw}", 422)
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
    except (WorkshopError, OSError, UnicodeDecodeError):
        return None
    files = [p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()]
    return SkillInfo(name=directory.name, description=str(meta.get("description") or "").strip(),
                     has_scripts=_has_scripts(files))


def list_skills() -> list[SkillInfo]:
    root = skills_dir()
    if not root.is_dir():
        return []
    rows = (_info(path) for path in sorted(root.iterdir())
            if path.is_dir() and not path.name.startswith("."))
    return [row for row in rows if row is not None]


def _skill_path(name: str) -> Path:
    if not NAME_PATTERN.fullmatch(name or ""):
        raise WorkshopError("INVALID_TARGET", f"没有名为 {name} 的 Skill", 404)
    path = skills_dir() / name
    if not (path / SKILL_FILE).is_file():
        raise WorkshopError("INVALID_TARGET", f"没有名为 {name} 的 Skill", 404)
    return path


def read_skill(name: str) -> str:
    """SKILL.md 正文（不含 frontmatter）+ 附带文件清单，模型按需继续读。"""
    path = _skill_path(name)
    _, body = parse_skill_md((path / SKILL_FILE).read_text(encoding="utf-8"))
    extra = sorted(p.relative_to(path).as_posix() for p in path.rglob("*")
                   if p.is_file() and p.name != SKILL_FILE)
    listing = ("\n\n附带文件（用 read_skill_file 读取）：\n" + "\n".join(f"- {p}" for p in extra)
               if extra else "")
    return (body.strip() + listing)[:MAX_READ_CHARS]


def read_skill_file(name: str, relative: str) -> str:
    root = _skill_path(name).resolve()
    target = (root / clean_relative(relative)).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise WorkshopError("INVALID_TARGET", f"Skill {name} 里没有文件 {relative}", 404)
    try:
        return target.read_bytes().decode("utf-8")[:MAX_READ_CHARS]
    except UnicodeDecodeError:
        raise WorkshopError("INVALID_PARAMETERS", "只能读取文本文件", 422) from None


def _strip_common_root(files: dict[str, bytes]) -> dict[str, bytes]:
    """zip / 文件夹常多套一层目录（my-skill/SKILL.md）：以最浅的 SKILL.md 所在目录为根。"""
    candidates = sorted((p for p in files if PurePosixPath(p).name == SKILL_FILE),
                        key=lambda p: len(PurePosixPath(p).parts))
    if not candidates:
        raise WorkshopError("INVALID_PARAMETERS", "没有找到 SKILL.md", 422)
    root = PurePosixPath(candidates[0]).parent.as_posix()
    if root == ".":
        return files
    prefix = f"{root}/"
    return {p[len(prefix):]: data for p, data in files.items() if p.startswith(prefix)}


def files_from_zip(payload: bytes) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        raise WorkshopError("INVALID_PARAMETERS", "不是有效的 zip 文件", 422) from None
    files: dict[str, bytes] = {}
    total = 0
    with archive:
        for entry in archive.infolist():
            if entry.is_dir() or entry.filename.startswith("__MACOSX/"):
                continue
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise WorkshopError("INVALID_PARAMETERS", f"zip 里有符号链接 {entry.filename}", 422)
            total += entry.file_size  # 先按声明大小拦，再按实际读出的字节数拦（防 zip 炸弹）
            if total > MAX_TOTAL_BYTES or len(files) >= MAX_FILES:
                raise WorkshopError("CONTENT_TOO_LARGE", TOO_LARGE, 413)
            with archive.open(entry) as handle:
                data = handle.read(MAX_TOTAL_BYTES + 1)
            if len(data) > entry.file_size:
                raise WorkshopError("CONTENT_TOO_LARGE", TOO_LARGE, 413)
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
        raise WorkshopError("CONTENT_TOO_LARGE", TOO_LARGE, 413)
    cleaned = _strip_common_root(cleaned)
    # 大小写不敏感的文件系统上 Readme.md 与 README.md 会写到同一个文件。
    if len({path.casefold() for path in cleaned}) != len(cleaned):
        raise WorkshopError("INVALID_PARAMETERS", "有只差大小写的同名文件", 422)
    try:
        meta, _ = parse_skill_md(cleaned[SKILL_FILE].decode("utf-8"))
    except UnicodeDecodeError:
        raise WorkshopError("INVALID_PARAMETERS", "SKILL.md 不是 UTF-8 文本", 422) from None
    name = _normalize_name(meta.get("name"))
    if not str(meta.get("description") or "").strip():
        raise WorkshopError("INVALID_PARAMETERS", "SKILL.md 缺少 description", 422)

    root = skills_dir()
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    if target.exists() and not replace:
        raise WorkshopError("SKILL_EXISTS", f"已经有名为 {name} 的 Skill", 409)
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
        raise WorkshopError("INVALID_PARAMETERS", "SKILL.md 无法读取", 422)
    return info


def delete_skill(name: str) -> None:
    shutil.rmtree(_skill_path(name))


def skills_prompt() -> str:
    """System prompt 里的 Skill 目录：只有名称和描述，正文按需加载。"""
    skills = list_skills()
    if not skills:
        return ""
    lines = "\n".join(f"- {skill.name}：{skill.description}" for skill in skills)
    return ("\n\n可用的 Skill（做法说明）。任务与某个 Skill 的描述相符时，先用 load_skill 读它再动手；"
            "Skill 里提到的脚本不能执行，只参考文字说明：\n" + lines)
