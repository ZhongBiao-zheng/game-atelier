"""A3 stale 传播 —— spec / style.md 变更后，比对定稿指纹给出「已变更」标记。

指纹在 set_canonical / set_screen_canonical 写入时盖章（spec_fingerprint 取
spec.md 的 visual_dna+anchors 两节，style_fingerprint 取项目 style.md 全文）；
本模块只做「存储指纹 vs 当前指纹」的只读比对，不落盘任何状态。

存储指纹为 ""（旧数据 / spec 缺失 / 未归属项目）时无从比对 → 按不 stale 处理，
重新定稿一次即自愈（写入当前指纹）。
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from character_workflow.lib import data_root, projects
from character_workflow.lib.canonical import read_canonical, spec_fingerprint
from character_workflow.lib.schemas import (
    CanonicalStatusEntry,
    CanonicalStatusFile,
    ScreenCanonicalStatusEntry,
    ScreenCanonicalStatusFile,
)


def _hash_file(p: Path) -> str:
    if not p.exists():
        return ""
    try:
        text = p.read_text(encoding="utf-8-sig")
    except OSError:
        return ""
    if not text.strip():
        return ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def style_fingerprint_for_slug(slug: str) -> str:
    """项目 style.md 全文 hash（12 hex）。文件缺失 / 空 → ""。"""
    return _hash_file(data_root.projects_dir() / slug / "style.md")


def style_fingerprint_for_character(character_id: str) -> str:
    """角色经 projects.json assignments 找到所属项目的 style.md hash；未归属 → ""。"""
    f = projects.read_projects()
    project_id = f.assignments.get(character_id)
    if not project_id:
        return ""
    for p in f.projects:
        if p.id == project_id:
            return style_fingerprint_for_slug(p.slug)
    return ""


def _is_stale(stored: str, current: str) -> bool:
    return bool(stored) and stored != current


def character_canonical_status(character_id: str) -> CanonicalStatusFile:
    """角色定稿表 + 计算出的 stale 标记（spec 与 style 各一维）。"""
    file = read_canonical(character_id)
    current_spec = spec_fingerprint(character_id)
    current_style = style_fingerprint_for_character(character_id)
    status = CanonicalStatusFile()
    for slot in ("portrait", "promo", "turnaround"):
        entry = getattr(file, slot)
        if entry is None:
            continue
        setattr(status, slot, CanonicalStatusEntry(
            **entry.model_dump(),
            spec_stale=_is_stale(entry.spec_fingerprint, current_spec),
            style_stale=_is_stale(entry.style_fingerprint, current_style),
        ))
    return status


def screen_canonical_status(project_id: str) -> ScreenCanonicalStatusFile:
    """项目 screen 定稿表 + style stale 标记。project 不存在时抛 KeyError（与读函数同口径）。"""
    from character_workflow.lib.ui_jobs import project_slug, read_screen_canonical

    slug = project_slug(project_id)
    current_style = style_fingerprint_for_slug(slug)
    file = read_screen_canonical(project_id)
    return ScreenCanonicalStatusFile(screens={
        screen_id: ScreenCanonicalStatusEntry(
            **entry.model_dump(),
            style_stale=_is_stale(entry.style_fingerprint, current_style),
        )
        for screen_id, entry in file.screens.items()
    })


def stale_report() -> dict:
    """全库 stale 摘要 —— skill 改 spec 锚点 / style.md 前列受影响定稿用。

    返回 {"characters": {id: {slot: {...}}}, "screens": {project_slug: {screen_id: {...}}}}，
    只含 stale 条目；全干净时两个 dict 皆空。
    """
    out: dict = {"characters": {}, "screens": {}}
    chars_dir = data_root.characters_dir()
    if chars_dir.exists():
        for cfile in sorted(chars_dir.glob("*/canonical.json")):
            cid = cfile.parent.name
            status = character_canonical_status(cid)
            hits = {
                slot: {
                    "path": e.path,
                    "spec_stale": e.spec_stale,
                    "style_stale": e.style_stale,
                }
                for slot in ("portrait", "promo", "turnaround")
                if (e := getattr(status, slot)) is not None and (e.spec_stale or e.style_stale)
            }
            if hits:
                out["characters"][cid] = hits
    for p in projects.read_projects().projects:
        cfile = data_root.projects_dir() / p.slug / "screens" / "canonical.json"
        if not cfile.exists():
            continue
        status = screen_canonical_status(p.id)
        hits = {
            screen_id: {"path": e.path, "style_stale": True}
            for screen_id, e in status.screens.items()
            if e.style_stale
        }
        if hits:
            out["screens"][p.slug] = hits
    return out
