"""出图确认卡的两种呈现：终端文本（stderr 原样转发）与 show_widget HTML（有可视化工具时）。

两种形态都由这里按 job JSON 生成，Skill 只负责转发，杜绝 Agent 手写漏字段或改字段。
按钮点击通过 sendPrompt 发出固定原话「出图 <job_id>」/「要改 <job_id>」/「先不出 <job_id>」，
让画师的回复落在 Skill 判定表里的明确分支，不再出现模糊表态。
"""
from __future__ import annotations

import html

from character_workflow.lib.schemas import AssetSlot, Job, JobKind

_SLOT_LABEL = {
    AssetSlot.PORTRAIT: "立绘",
    AssetSlot.PROMO: "美宣",
    AssetSlot.TURNAROUND: "三视图",
}


def _rows(job: Job) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = [
        ("job_id", job.job_id),
        ("Key", f"{job.alias} ({job.provider})"),
        ("model", job.model),
    ]
    if job.kind is JobKind.VIDEO:
        rows.append(("参数", f"{job.params.duration}s · {job.params.resolution} · {job.params.ratio}"))
    else:
        rows.append(("size", f"{job.params.size}  n: {job.params.n}"))
    if job.screen_id:
        rows.insert(1, ("screen", f"{job.screen_id}（UI 页面 job，产物归项目）"))
        if job.params.style_variant:
            base = f" ← {job.params.base_version}" if job.params.base_version else ""
            rows.insert(2, ("风格", f"{job.params.style_variant}{base}"))
    if job.production_id:
        rows.insert(1, ("企划", f"{job.production_id}（项目完整视频 job）"))
    if job.retry_of:
        rows.append(("retry_of", f"{job.retry_of}（原 job 错误记录已保留）"))
    return rows


def _reference_groups(job: Job) -> list[tuple[str, str, list[str]]]:
    groups = [("参考图", "张", list(job.params.reference_images or []))]
    if job.kind is JobKind.VIDEO:
        groups.append(("参考视频", "个", list(job.params.reference_videos or [])))
        groups.append(("参考音频", "个", list(job.params.reference_audios or [])))
    return groups


def _kind_label(job: Job) -> str:
    if job.screen_id:
        return "UI 页面"
    if job.production_id:
        return "项目视频"
    if job.kind is JobKind.VIDEO:
        return "视频"
    return _SLOT_LABEL.get(job.asset_slot, job.namespace)


def _pad(label: str) -> str:
    # 终端里 CJK 占两列，按显示宽度补到 7 列，保持历史文本卡的对齐格式。
    width = sum(2 if ord(ch) > 127 else 1 for ch in label)
    return label + " " * max(0, 7 - width)


def confirmation_card_text(job: Job) -> str:
    """终端文本卡：CLI 打到 stderr，Skill 原样转发。"""
    lines = ["─── 出图确认卡 ───"]
    for label, value in _rows(job):
        lines.append(f"{_pad(label)}: {value}")
    for label, unit, paths in _reference_groups(job):
        lines.append(f"{_pad(label)}: {len(paths)} {unit}")
        lines.extend(f"  {i}. {p}" for i, p in enumerate(paths, 1))
    lines.append(f"{_pad('prompt')}:")
    lines.append(job.prompt.rstrip("\n"))
    lines.append("─── 画师确认后 run-job ───")
    return "\n".join(lines)


def confirmation_card_html(job: Job) -> str:
    """show_widget 卡片：整段 HTML 原样作为 widget_code 传入，不做任何改写。"""
    e = html.escape
    verb = "出视频" if job.kind is JobKind.VIDEO else "出图"
    label_td = 'style="color: var(--text-secondary); padding: 4px 12px 4px 0; width: 72px; vertical-align: top; white-space: nowrap;"'
    value_td = 'style="padding: 4px 0; font-family: var(--font-mono); word-break: break-all;"'
    rows_html = "".join(
        f"<tr><td {label_td}>{e(label)}</td><td {value_td}>{e(value)}</td></tr>"
        for label, value in _rows(job)
    )
    refs_html = ""
    for label, unit, paths in _reference_groups(job):
        items = "".join(
            f'<li style="word-break: break-all;">{e(p)}</li>' for p in paths
        )
        listing = (
            f'<ol style="margin: 4px 0 0; padding-left: 20px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6;">{items}</ol>'
            if paths else ""
        )
        refs_html += (
            f'<p style="font-size: 13px; color: var(--text-secondary); margin: 12px 0 0;">{e(label)} · {len(paths)} {unit}</p>'
            f"{listing}"
        )
    buttons = "".join(
        f'<button data-say="{e(say, quote=True)}">{e(text)} ↗</button>'
        for text, say in (
            (verb, f"{verb} {job.job_id}"),
            ("要改", f"要改 {job.job_id}"),
            ("先不出", f"先不出 {job.job_id}"),
        )
    )
    return (
        f'<h2 class="sr-only">{e(verb)}确认卡：{e(job.job_id)}，等待画师确认后才会调用供应商</h2>'
        '<div style="background: var(--surface-2); border-radius: 12px; border: 0.5px solid var(--border); padding: 1rem 1.25rem;">'
        '<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">'
        f'<p style="font-weight: 500; font-size: 15px; margin: 0; flex: 1;">{e(verb)}确认</p>'
        f'<span style="font-size: 12px; padding: 4px 12px; border-radius: var(--radius); background: var(--surface-1); color: var(--text-secondary);">{e(_kind_label(job))}</span>'
        '<span style="font-size: 12px; padding: 4px 12px; border-radius: var(--radius); background: var(--bg-warning); color: var(--text-warning);">等待确认</span>'
        "</div>"
        f'<table style="width: 100%; font-size: 13px; border-top: 0.5px solid var(--border); padding-top: 8px;">{rows_html}</table>'
        f"{refs_html}"
        '<p style="font-size: 13px; color: var(--text-secondary); margin: 12px 0 4px;">提示词</p>'
        '<pre style="margin: 0; padding: 12px; background: var(--surface-1); border-radius: var(--radius); font-family: var(--font-mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;">'
        f"{e(job.prompt.rstrip(chr(10)))}</pre>"
        f'<div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px;">{buttons}</div>'
        "</div>"
        "<script>document.querySelectorAll('button[data-say]').forEach(function (b) {"
        " b.addEventListener('click', function () { sendPrompt(b.dataset.say); }); });</script>"
    )
