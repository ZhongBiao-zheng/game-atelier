"""数据校验器 validate-data（A4）—— 扫 <data_root> 全部数据面，报「文件 + 问题」。

背景：手写 job JSON 一条 schema 错 → `/api/jobs` 整体 500 的事故有先例；
spec 占位符、canonical / 画廊 sidecar 引用断链此前零检测。

五类检查：
① job JSON 逐条 Pydantic 校验（定位到文件 + 字段路径）          → error
② DONE job 的 output_paths / 各 job source_image 存在性        → error / warning
③ spec.md / style.md / 锚文档 / brief / screen-map 零占位       → error
④ canonical（角色 + screen）结构合法且引用文件真实存在           → error
⑤ ratings / favorites / hidden 画廊 sidecar 断链               → warning（文件坏 → error）

只读不写；lib 返回结构化 Report，CLI 负责人类可读输出与退出码。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

from character_workflow.lib import data_root, projects
from character_workflow.lib.schemas import (
    CanonicalFile,
    Job,
    JobStatus,
    ScreenCanonicalFile,
    VideoReferencesFile,
)

# 与 spec-template / style-template 的「禁止占位词」纪律对齐。
_PLACEHOLDER_TOKENS = ("TBD", "待定", "TODO", "FIXME")


@dataclass
class Issue:
    level: str  # "error" | "warning"
    category: str  # "job" | "asset" | "placeholder" | "canonical" | "sidecar"
    file: str  # data-root 相对路径（定位用）
    detail: str


@dataclass
class Report:
    issues: list[Issue] = field(default_factory=list)
    checked: dict[str, int] = field(default_factory=dict)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "warning"]


def _rel(p: Path, root: Path) -> str:
    try:
        return p.resolve().relative_to(root).as_posix()
    except ValueError:
        return p.as_posix()


def _err(report: Report, category: str, file: str, detail: str) -> None:
    report.issues.append(Issue("error", category, file, detail))


def _warn(report: Report, category: str, file: str, detail: str) -> None:
    report.issues.append(Issue("warning", category, file, detail))


# ---------- ① job JSON + ② 资产存在性 ----------

def _check_jobs(report: Report, root: Path) -> None:
    jobs_dir = root / ".runtime" / "jobs"
    count = 0
    if jobs_dir.exists():
        for p in sorted(jobs_dir.glob("*.json")):
            count += 1
            rel = _rel(p, root)
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                _err(report, "job", rel, f"JSON 无法解析: {e}")
                continue
            if isinstance(data, dict):
                data.pop("seed", None)  # 与 jobs._load_job 同口径：已废弃字段不算错
            try:
                job = Job.model_validate(data)
            except ValidationError as e:
                for item in e.errors():
                    loc = ".".join(str(x) for x in item["loc"]) or "<root>"
                    _err(report, "job", rel, f"字段 {loc}: {item['msg']}")
                continue
            _check_job_assets(report, root, rel, job)
    report.checked["jobs"] = count


def _check_job_assets(report: Report, root: Path, rel: str, job: Job) -> None:
    if job.status == JobStatus.DONE:
        for out in job.output_paths:
            p = Path(out)
            abs_p = p if p.is_absolute() else root / p
            if not abs_p.is_file():
                _err(report, "asset", rel, f"output_paths 引用不存在: {out}")
    if job.source_image:
        p = Path(job.source_image)
        abs_p = p if p.is_absolute() else root / p
        if not abs_p.is_file():
            _warn(report, "asset", rel, f"source_image 参考图不存在: {job.source_image}")


# ---------- ③ 文档零占位 ----------

def _check_placeholders_in(report: Report, root: Path, p: Path) -> None:
    try:
        text = p.read_text(encoding="utf-8-sig")
    except OSError as e:
        _err(report, "placeholder", _rel(p, root), f"无法读取: {e}")
        return
    rel = _rel(p, root)
    for lineno, line in enumerate(text.splitlines(), start=1):
        for token in _PLACEHOLDER_TOKENS:
            if token in line:
                _err(report, "placeholder", rel, f"L{lineno} 含占位词 {token!r}: {line.strip()}")
        # 字段值就是一个问号（`- xx: ?` / `| ? |`）也算占位；prose 里的正常问句不误伤。
        stripped = line.strip()
        if stripped.endswith((": ?", ":?", "| ? |")) or stripped in ("?", "- ?"):
            _err(report, "placeholder", rel, f"L{lineno} 字段值为占位问号: {stripped}")


def _doc_files(root: Path) -> list[Path]:
    docs: list[Path] = []
    chars = data_root.characters_dir()
    if chars.exists():
        docs.extend(sorted(chars.glob("*/spec.md")))
    for proj in _known_projects():
        pdir = data_root.projects_dir() / proj.slug
        for candidate in (
            pdir / "style.md",
            pdir / "design" / "gdd.md",
            pdir / "design" / "prd.md",
            pdir / "design" / "interaction.md",
        ):
            if candidate.exists():
                docs.append(candidate)
        from character_workflow.lib.ui_schemes import read_existing_schemes, scheme_dir
        schemes = read_existing_schemes(proj.id)
        if schemes is None:
            continue
        for scheme in schemes.schemes:
            ui_dir = scheme_dir(proj, scheme.id)
            for candidate in (ui_dir / "style.md", ui_dir / "screens" / "screen-map.md"):
                if candidate.exists():
                    docs.append(candidate)
            screens = ui_dir / "screens"
            if screens.exists():
                docs.extend(
                    sorted(p for p in screens.glob("*.md") if p.name != "screen-map.md")
                )
    return docs


def _check_placeholders(report: Report, root: Path) -> None:
    docs = _doc_files(root)
    for p in docs:
        _check_placeholders_in(report, root, p)
    report.checked["docs"] = len(docs)


# ---------- ④ canonical 引用 ----------

def _check_character_canonical(report: Report, root: Path) -> int:
    chars = data_root.characters_dir()
    count = 0
    if not chars.exists():
        return 0
    for cfile in sorted(chars.glob("*/canonical.json")):
        count += 1
        rel = _rel(cfile, root)
        char_dir = cfile.parent
        try:
            file = CanonicalFile.model_validate(json.loads(cfile.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, ValidationError) as e:
            _err(report, "canonical", rel, f"结构非法: {e}")
            continue
        for slot in ("portrait", "promo", "turnaround"):
            entry = getattr(file, slot)
            if entry is None:
                continue
            abs_p = root / entry.path
            if not abs_p.is_file():
                _err(report, "canonical", rel, f"{slot} 定稿引用不存在: {entry.path}")
            elif char_dir.resolve() / slot not in abs_p.resolve().parents:
                _err(
                    report, "canonical", rel,
                    f"{slot} 定稿不在本角色 {slot} 目录下: {entry.path}",
                )
    return count


def _check_screen_canonical(report: Report, root: Path) -> int:
    count = 0
    from character_workflow.lib.ui_schemes import read_existing_schemes, scheme_screens_dir
    for proj in _known_projects():
        schemes = read_existing_schemes(proj.id)
        if schemes is None:
            continue
        for scheme in schemes.schemes:
            cfile = scheme_screens_dir(proj, scheme.id) / "canonical.json"
            if not cfile.exists():
                continue
            count += 1
            rel = _rel(cfile, root)
            try:
                file = ScreenCanonicalFile.model_validate(
                    json.loads(cfile.read_text(encoding="utf-8"))
                )
            except (OSError, json.JSONDecodeError, ValidationError) as e:
                _err(report, "canonical", rel, f"结构非法: {e}")
                continue
            for screen_id, entry in file.screens.items():
                abs_p = root / entry.path
                if not abs_p.is_file():
                    _err(
                        report,
                        "canonical",
                        rel,
                        f"screen {screen_id} 定稿引用不存在: {entry.path}",
                    )
    return count


def _check_canonicals(report: Report, root: Path) -> None:
    n = _check_character_canonical(report, root)
    n += _check_screen_canonical(report, root)
    report.checked["canonicals"] = n


def _check_video_references(report: Report, root: Path) -> None:
    from character_workflow.lib.video_jobs import is_project_reference_path, require_shot

    count = 0
    for project in _known_projects():
        videos = data_root.projects_dir() / project.slug / "videos"
        if not videos.is_dir():
            continue
        for path in sorted(videos.glob("*/references.json")):
            count += 1
            rel = _rel(path, root)
            try:
                file = VideoReferencesFile.model_validate_json(path.read_text(encoding="utf-8"))
            except (OSError, ValidationError) as error:
                _err(report, "reference", rel, f"结构非法: {error}")
                continue
            for shot_id, paths in file.shots.items():
                try:
                    require_shot(path.parent, path.parent.name, shot_id)
                except (FileNotFoundError, ValueError) as error:
                    _err(report, "reference", rel, str(error))
                if len(paths) != len(set(paths)):
                    _err(report, "reference", rel, f"shot {shot_id} 参考素材存在重复路径")
                for reference in paths:
                    if not is_project_reference_path(project.id, reference):
                        _err(
                            report,
                            "reference",
                            rel,
                            f"shot {shot_id} 参考素材不属于当前项目: {reference}",
                        )
                    elif not (root / reference).is_file():
                        _err(
                            report,
                            "reference",
                            rel,
                            f"shot {shot_id} 参考素材不存在: {reference}",
                        )
    report.checked["video_references"] = count


# ---------- ⑤ 画廊 sidecar 断链 ----------

def _check_sidecars(report: Report, root: Path) -> None:
    runtime = root / ".runtime"
    count = 0

    def _paths_exist(rel_file: str, paths: list[str]) -> None:
        for rel_path in paths:
            if not isinstance(rel_path, str) or not (root / rel_path).is_file():
                _warn(report, "sidecar", rel_file, f"引用不存在: {rel_path}")

    ratings = runtime / "gallery-ratings.json"
    if ratings.exists():
        count += 1
        rel = _rel(ratings, root)
        try:
            data = json.loads(ratings.read_text(encoding="utf-8"))
            _paths_exist(rel, list(data.get("ratings", {}).keys()))
        except (OSError, json.JSONDecodeError, AttributeError) as e:
            _err(report, "sidecar", rel, f"无法解析: {e}")

    for name in ("gallery-favorites.json", "gallery-hidden.json"):
        p = runtime / name
        if not p.exists():
            continue
        count += 1
        rel = _rel(p, root)
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            _paths_exist(rel, list(data.get("paths", [])))
        except (OSError, json.JSONDecodeError, AttributeError) as e:
            _err(report, "sidecar", rel, f"无法解析: {e}")

    report.checked["sidecars"] = count


def _known_projects() -> list:
    try:
        return list(projects.read_projects().projects)
    except Exception:
        return []


def validate_data() -> Report:
    """跑全部五类检查，返回结构化 Report。只读不写。"""
    root = data_root.resolve_data_root().resolve()
    report = Report()
    _check_jobs(report, root)
    _check_placeholders(report, root)
    _check_canonicals(report, root)
    _check_video_references(report, root)
    _check_sidecars(report, root)
    return report


def format_report(report: Report) -> str:
    """人类可读输出：问题逐条（error 在前），末尾统计摘要。"""
    lines: list[str] = []
    for issue in sorted(report.issues, key=lambda i: (i.level != "error", i.file)):
        mark = "✗" if issue.level == "error" else "⚠"
        lines.append(f"{mark} [{issue.category}] {issue.file} — {issue.detail}")
    if lines:
        lines.append("")
    checked = report.checked
    lines.append(
        "检查完成: "
        f"jobs {checked.get('jobs', 0)} / 文档 {checked.get('docs', 0)} / "
        f"canonical {checked.get('canonicals', 0)} / sidecar {checked.get('sidecars', 0)} —— "
        f"{len(report.errors)} errors, {len(report.warnings)} warnings"
    )
    return "\n".join(lines)
