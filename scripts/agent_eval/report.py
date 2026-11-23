"""Offline grading and human review for the scrubbed public observations of a run."""

import base64
import csv
import json
import os
import re
from collections import Counter
from datetime import datetime
from html import escape
from pathlib import Path
from statistics import mean
from urllib.parse import quote

from PIL import Image, ImageOps

from .media_artifacts import video_contact_sheet


LABELS = {
    "images": "图片张数",
    "videos": "视频段数",
    "duration_s": "视频时长",
    "dimensions": "尺寸与比例",
    "orientation": "画面方向",
    "model_family": "模型族",
    "uses_all_attachments": "附件引用",
    "uses_previous_result": "沿用上一轮结果",
    "on_canvas": "画布结果与选中节点相连",
    "asks_user": "反问用户",
    "skills": "技能加载",
    "no_resubmit_after_failure": "失败后未重提",
    "generation_limit": "每轮生成份数",
}
VERDICTS = {"pass": "通过", "fail": "不通过", "na": "不适用"}
STATES = {"completed": "完成", "failed": "失败", "stopped": "已停止", "not_applicable": "不适用"}
SCORE_FIELDS = ("符合需求", "提示词质量", "画面质量", "备注")


def _json(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)


def _local(root, name):
    """Accept only relative artifact paths inside their own results directory."""
    part = Path(name)
    if part.is_absolute() or not name or ".." in part.parts:
        raise ValueError("报告文件路径超出结果目录")
    path = (root / part).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("报告文件路径超出结果目录")
    return path


def _dump_json(path, value):
    path.write_text(_json(value) + "\n", encoding="utf-8")


def _prepare_media(directory, row):
    for i, job in enumerate(row.get("generations") or [], 1):
        _local(directory, f"generation-{i:02d}-prompt.txt").write_text(
            job.get("prompt") or "", encoding="utf-8"
        )
        for j, item in enumerate(job.get("outputs") or [], 1):
            item["width"] = item["height"] = None
            item.pop("preview", None)
            if not item.get("path"):
                item["media_error"] = "缺少结果文件"
                continue
            path = _local(directory, item["path"])
            try:
                kind = item.get("kind") or job.get("kind")
                if kind == "video" and item.get("artifact") == "contact_sheet":
                    with Image.open(path) as sheet:
                        preview = sheet.convert("RGB")
                    size = (item.get("source_width"), item.get("source_height"))
                    preview.thumbnail((560, 360), Image.Resampling.LANCZOS)
                elif kind == "video":
                    preview, size, item["duration_s"] = video_contact_sheet(path)
                elif kind == "image":
                    with Image.open(path) as image:
                        preview = ImageOps.exif_transpose(image)
                        size = preview.size
                        preview.thumbnail((560, 360), Image.Resampling.LANCZOS)
                else:
                    continue
                output = _local(directory, f"preview-{i:02d}-{j:02d}.jpg")
                preview.convert("RGB").save(output, quality=85)
                item.update(width=size[0], height=size[1], preview=output.name, kind=kind)
            except (OSError, ValueError, Image.DecompressionBombError):
                item["media_error"] = "无法读取结果媒体"


def _check(value, reason):
    return {"status": "na" if value is None else ("pass" if value else "fail"), "reason": reason}


def _shape(expect, items):
    if not (expect.get("size") or expect.get("ratio")):
        return _check(None, "未指定尺寸或比例")
    size, ratio = expect.get("size"), expect.get("ratio")
    wanted_size = re.fullmatch(r"\s*(\d+)\s*[xX×]\s*(\d+)\s*", str(size)) if size else None
    wanted_ratio = re.fullmatch(r"\s*(\d+)\s*:\s*(\d+)\s*", str(ratio)) if ratio else None
    if (size and not wanted_size) or (ratio and not wanted_ratio):
        raise ValueError("清单 size 需为 宽x高，ratio 需为 宽:高")
    sizes = [(o.get("width"), o.get("height")) for o in items]
    known = [(w, h) for w, h in sizes if w and h]
    ok = True
    allowed = []
    if wanted_size:
        target = tuple(map(int, wanted_size.groups()))
        ok &= all(actual == target for actual in known)
        allowed.append(f"必须精确为 {target[0]}×{target[1]} 像素")
    if wanted_ratio:
        a, b = map(int, wanted_ratio.groups())
        ok &= all(100 * abs(w * b - h * a) <= 2 * h * a for w, h in known)
        allowed.append(f"{a}:{b} 允许 ±2%（宽高比约 {0.98 * a / b:.5f} 至 {1.02 * a / b:.5f}）")
    measured = "、".join(f"{w}×{h}（{w / h:.5f}）" if w and h else "无法解码" for w, h in sizes)
    result = None if not sizes or (ok and len(known) < len(sizes)) else ok
    return _check(result, f"{'，'.join(allowed)}，实测 {measured or '无结果'}")


def _attachments(expect, row, jobs):
    if expect.get("uses_all_attachments") is None:
        return _check(None, "未指定引用要求")
    wanted = row.get("attachments") or []
    if not wanted:
        return _check(None, "需求没有附件")
    refs = [ref for job in jobs for ref in (job.get("references") or [])]
    used = {ref.get("sha256") for ref in refs if ref.get("sha256")}
    missing = [a["name"] for a in wanted if not a.get("sha256") or a["sha256"] not in used]
    unknown = any(not ref.get("sha256") for ref in refs) or any(
        "references" not in job or job["references"] is None for job in jobs
    )
    if missing and (unknown or any(not a.get("sha256") for a in wanted)):
        return _check(None, "参考文件证据不完整")
    return _check(
        (not missing) == expect["uses_all_attachments"],
        "未引用 " + "、".join(missing) if missing else f"{len(wanted)} 个附件均已引用",
    )


def _skills(expect, row):
    requested = set(expect.get("skills") or [])
    if not requested:
        return _check(None, "未指定技能")
    loaded = row.get("loaded_skills")
    available = row.get("available_skills")
    if loaded is None:
        return _check(None, "当前接口未提供技能加载记录")
    missing = requested - set(loaded)
    if not missing:
        return _check(True, "、".join(sorted(requested)))
    if available is not None and (observable := missing & set(available)):
        return _check(False, "未加载 " + "、".join(sorted(observable)))
    return _check(None, "当前版本未报告技能 " + "、".join(sorted(missing)))


def _retry(row, jobs):
    if row.get("resubmitted_after_failure") is not None:
        return _check(not row["resubmitted_after_failure"], "按同一轮生成提交记录核对")
    # A later user turn can legitimately ask to try again. Jobs submitted before the failure
    # are parallel work, so their submission time must not count as a retry.
    uncertain = False
    for i, job in enumerate(jobs):
        if job.get("status") not in ("failed", "error"):
            continue
        for other in jobs[i + 1 :]:
            if job.get("turn_index") != other.get("turn_index"):
                continue
            finish, start = job.get("completed_at"), other.get("submitted_at")
            if not finish or not start or (job.get("turn_index") is None and len(row["turns"]) > 1):
                uncertain = True
                continue
            try:
                if datetime.fromisoformat(start) > datetime.fromisoformat(finish):
                    return _check(False, "任务失败后同一轮又有提交")
            except (TypeError, ValueError):
                uncertain = True
    failed_turns = set()
    for step in row.get("steps") or []:
        if step.get("tool") not in ("run_generation", "run_generations"):
            continue
        turn = step.get("turn_index")
        if turn in failed_turns:
            return _check(False, "生成工具报错后同一轮再次调用")
        if step.get("status") == "failed":
            failed_turns.add(turn)
    if uncertain or row.get("steps") is None:
        return _check(None, "缺少提交时间或步骤记录")
    return _check(True, "未观察到失败后重提")


def _requested(expect):
    keys = {"no_resubmit_after_failure", "generation_limit"}
    keys.update(k for k, value in expect.items() if k in LABELS and value is not None)
    if expect.get("size") or expect.get("ratio"):
        keys.add("dimensions")
    return [key for key in LABELS if key in keys]


def _output_count(expected, items, unit):
    known = sum(
        bool(item.get("preview") or (item.get("width") and item.get("height"))) for item in items
    )
    unavailable = sum(bool(item.get("media_error") or item.get("error")) for item in items)
    if unavailable and known <= expected <= known + unavailable:
        return _check(None, "部分登记的结果无法读取")
    return _check(known == expected, f"实得 {known} {unit}，期望 {expected} {unit}")


def _all_match(results, expected, reason):
    if not results:
        return _check(None, "没有可判定的结果")
    actual = False if False in results else None if None in results else True
    return _check(None if actual is None else actual == expected, reason)


def _used_previous(expect, previous, jobs):
    if previous is None:
        return _check(None, "缺少上一轮结果记录")
    previous_items = [item for job in previous for item in job.get("outputs") or []]
    hashes = {item["source_sha256"] for item in previous_items if item.get("source_sha256")}
    missing_hash = any(not item.get("source_sha256") for item in previous_items)
    linked = []
    for job in jobs:
        references = job.get("references")
        if references is None:
            linked.append(None)
        elif any(ref.get("sha256") in hashes for ref in references):
            linked.append(True)
        elif references and (missing_hash or any(not ref.get("sha256") for ref in references)):
            linked.append(None)
        else:
            linked.append(False)
    return _all_match(
        linked,
        expect,
        f"按原始文件 SHA-256 核对，{linked.count(True)}/{len(jobs)} 次生成引用上一轮结果",
    )


def _image_family(model):
    # Match modelFamily.ts, with the Gemini image aliases from imageSizeCatalog.ts.
    model_id = model.rsplit("/", 1)[-1].lower().replace("_", "-")
    if model_id.startswith(("mj-", "niji")) or "midjourney" in model_id:
        return "midjourney"
    if "gpt-image" in model_id:
        return "gpt-image"
    if "nano-banana" in model_id or re.match(
        r"^gemini-.*-image(?:-|$)", model_id.replace(".", "-")
    ):
        return "nano-banana"
    if "seedream" in model_id or "seededit" in model_id:
        return "seedream"
    return "standard"


def _generation_limit(expect, jobs):
    counts = [expect[key] for key in ("images", "videos") if key in expect]
    if not counts:
        return _check(None, "本轮未指定期望的图片张数或视频段数")
    expected = sum(counts)
    allowed = expected * 2
    media_jobs = [job for job in jobs if job.get("kind") in ("image", "video")]
    observed = sum(len(job.get("outputs") or []) for job in media_jobs)
    complete = all(job.get("outputs") is not None for job in media_jobs)
    known = str(observed) if complete else f"至少 {observed}"
    reason = (
        f"本轮已登记 {known} 份（图片和视频合计），期望 {expected} 份"
        f" + 一轮修正最多 {expected} 份 = 上限 {allowed} 份"
    )
    return _check(None if not complete and observed <= allowed else observed <= allowed, reason)


def _turn_checks(row, previous):
    expect = row["expect"]
    keys = _requested(expect)
    if row["status"] != "completed":
        reason = row.get("reason") or row.get("error") or STATES.get(row["status"], row["status"])
        return {key: _check(None, f"本轮未完成，{reason}") for key in keys}
    jobs = row.get("generations") or []
    items = [item for job in jobs for item in job.get("outputs") or []]
    images = [item for item in items if item.get("kind") == "image"]
    videos = [item for item in items if item.get("kind") == "video"]
    checks = {
        "no_resubmit_after_failure": _retry(row, jobs),
        "generation_limit": _generation_limit(expect, jobs),
    }
    if "images" in keys:
        checks["images"] = _output_count(expect["images"], images, "张")
    if "videos" in keys:
        checks["videos"] = _output_count(expect["videos"], videos, "段")
    if "dimensions" in keys:
        checks["dimensions"] = _shape(expect, items)
    if "duration_s" in keys:
        durations = [item.get("duration_s") for item in videos]
        measured = "、".join("未知" if d is None else f"{d:.3f} 秒" for d in durations)
        target = expect["duration_s"]
        low, high = target - 0.5, target + 0.5
        reason = f"期望 {target:g} 秒，允许 {low:g} 至 {high:g} 秒（±0.5 秒），实测 {measured or '无结果'}"
        checks["duration_s"] = (
            _all_match([None if d is None else low <= d <= high for d in durations], True, reason)
            if durations
            else _check(None, reason)
        )
    if "orientation" in keys:
        wanted = expect["orientation"]
        actual = []
        for item in items:
            w, h = item.get("width"), item.get("height")
            actual.append(None if not w or not h else (w < h if wanted == "portrait" else w > h))
        checks["orientation"] = _all_match(
            actual, True, f"期望{'竖版' if wanted == 'portrait' else '横版'}，按实测宽高判定"
        )
    if "uses_previous_result" in keys:
        checks["uses_previous_result"] = _used_previous(
            expect["uses_previous_result"], previous, jobs
        )
    if "on_canvas" in keys:
        connections = [job.get("on_canvas") for job in jobs]
        if not connections and row.get("on_canvas") is not None:
            connections = [row["on_canvas"]]
        reason = f"{connections.count(True)}/{len(jobs)} 个结果有画布版本与选中节点直连证据"
        checks["on_canvas"] = _all_match(connections, expect["on_canvas"], reason)
    if "model_family" in keys:
        family = expect["model_family"].lower().replace("_", "-")
        models = [job.get("model") for job in jobs]
        families = [_image_family(model) if model else None for model in models]
        matches = [None if actual is None else actual == family for actual in families]
        measured = "、".join(f"{m}（{f}）" if m else "未知模型" for m, f in zip(models, families))
        checks["model_family"] = _all_match(
            matches or [False], True, f"期望 {family}，实际 {measured or '没有生成'}"
        )
    if "uses_all_attachments" in keys:
        checks["uses_all_attachments"] = _attachments(expect, row, jobs)
    if "asks_user" in keys:
        reply = row.get("final_reply") or ""
        question = not jobs and bool(re.search(r"[?？][\s”’」』）)\]*_]*$", reply))
        checks["asks_user"] = (
            _check(question == expect["asks_user"], "出现反问" if question else "未出现反问")
            if (reply or jobs)
            else _check(None, "没有最终回复或生成记录")
        )
    if "skills" in keys:
        checks["skills"] = _skills(expect, row)
    if row.get("generations") is None:
        for key in keys:
            if key != "skills":
                checks[key] = _check(None, "缺少本轮的生成记录")
    return {key: checks[key] for key in keys}


def _turn_items(items, number, multi):
    if items is None:
        return None
    if not multi:
        return items
    if any(item.get("turn_index") is None for item in items):
        return None
    return [item for item in items if item["turn_index"] == number]


def machine_checks(row):
    """Evaluate each turn independently; a case-level expectation describes the last turn."""
    turns = row["turns"]
    multi = len(turns) > 1
    outcomes = {item["turn_index"]: item for item in row.get("turn_outcomes", [])}
    checks = {}
    previous = None
    for number, turn in enumerate(turns, 1):
        outcome = outcomes.get(number)
        expect = dict(turn.get("expect") or {})
        if number == len(turns):
            expect.update(row.get("expect") or {})
        jobs = _turn_items(row.get("generations"), number, multi)
        steps = _turn_items(row.get("steps"), number, multi)
        # Only a one-turn case can safely use the session-level reply, skills or attachments.
        observation = row if not multi else {"status": row["status"]}
        focused = {
            **observation,
            **(outcome or {}),
            "turns": [turn],
            "expect": expect,
            "available_skills": row.get("available_skills"),
            "generations": jobs,
            "steps": steps,
        }
        if (multi and outcome is None) or row["status"] == "not_applicable" and not outcome:
            focused.update(status="not_applicable", reason=row.get("reason") or "没有本轮观测")
        for name, check in _turn_checks(focused, previous).items():
            checks[f"{number}.{name}" if multi else name] = check
        previous = jobs if focused["status"] == "completed" else None
    return checks


METRICS = {
    "total_cost_cny": ("费用 / 元", 4),
    "tokens": ("Token", 0),
    "elapsed_seconds": ("耗时 / 秒", 2),
    "step_count": ("步数", 1),
    "validation_errors": ("参数退回", 1),
}


def _metric(row, key):
    usage = row.get("usage") or {}
    if row.get("status") == "not_applicable":
        return None
    if key == "tokens":
        parts = [usage.get("input_tokens"), usage.get("output_tokens")]
        return sum(parts) if all(x is not None for x in parts) else None
    if key == "total_cost_cny":
        return usage.get(key) if usage.get("cost_complete", True) else None
    return row.get(key)


def _number(value, places=2):
    if value is None:
        return "—"
    if places == 0:
        return f"{value:,.0f}"
    return f"{value:,.{places}f}".rstrip("0").rstrip(".")


def _rate(rows, keys):
    counts = Counter(
        check["status"]
        for row in rows
        for key, check in row["checks"].items()
        if key.rsplit(".", 1)[-1] in keys
    )
    n = counts["pass"] + counts["fail"]
    return counts["pass"], n


def _show_rate(values):
    passed, n = values
    return f"{100 * passed / n:.1f}% ({passed}/{n})" if n else "—"


def _average(rows, key):
    observed = [x for row in rows if (x := _metric(row, key)) is not None]
    return mean(observed) if observed else None


def _e(value):
    return escape(str(value))


def _pre(value):
    return "<pre>" + _e(value if isinstance(value, str) else _json(value)) + "</pre>"


def _table(headers, body):
    return (
        '<div class="scroll"><table><thead><tr>'
        + "".join(f"<th>{x}</th>" for x in headers)
        + "</tr></thead><tbody>"
        + "".join("<tr>" + "".join(f"<td>{v}</td>" for v in row) + "</tr>" for row in body)
        + "</tbody></table></div>"
    )


def _verdict(check):
    status = check["status"]
    return f'<span class="{_e(status)}">{_e(VERDICTS[status])}</span>'


_STYLE = """
:root{color-scheme:light;--text:#242726;--muted:#555f5a;--line:#d7dcd8;--tint:#f1f4f1}
*{box-sizing:border-box}body{margin:0;color:var(--text);background:#fafbf9;font:15px/1.55 system-ui,sans-serif}
main{max-width:1220px;margin:auto;padding:40px clamp(18px,4vw,52px) 80px}h1,h2,h3,p,figure{margin:0}
h1{font:500 clamp(31px,4vw,46px)/1.25 Georgia,"Songti SC",serif;margin-bottom:16px}h2{font:500 26px/1.35 Georgia,"Songti SC",serif}
h3,summary{font-size:15px;font-weight:620}h3{margin:16px 0 6px}p,figcaption,.muted{color:var(--muted)}
article{padding:28px 0;border-top:2px solid var(--text);margin-top:32px}article header{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
section{margin:22px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:5px 0 10px;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;vertical-align:top;border-bottom:1px solid var(--line);text-align:left}th{white-space:nowrap;font-weight:550;color:var(--muted);background:var(--tint)}
td{overflow-wrap:anywhere}a{color:#265744;text-underline-offset:3px}pre,.copy{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;padding:10px;background:var(--tint);border-radius:4px}
pre{font:13px/1.5 ui-monospace,monospace}details{margin:12px 0}summary{cursor:pointer}.pass{color:#246044}.fail{color:#942e20;font-weight:650}.na{color:var(--muted)}
.media,.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:14px;align-items:start}.pair{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
figure img{display:block;max-width:100%;max-height:290px;border-radius:4px}figcaption{font-size:12px;margin-top:4px}.metrics{display:flex;flex-wrap:wrap;gap:8px 22px;margin:10px 0}.metrics b{font-variant-numeric:tabular-nums;font-weight:600}
@media(max-width:650px){main{padding-top:20px}.pair{gap:8px}.scroll th,.scroll td{padding:6px}}
"""


def _page(title, content):
    # The only inline resource is our stylesheet. All thumbnails are embedded JPEGs.
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
        "img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">"
        f"<title>{_e(title)}</title><style>{_STYLE}</style></head><body><main>"
        f"<h1>{_e(title)}</h1>{content}</main></body></html>"
    )


def _gallery(directory, jobs, page_dir):
    figures = []
    for job in jobs:
        for item in job.get("outputs") or []:
            if not item.get("preview"):
                continue
            path = _local(directory, item["preview"])
            if not path.is_file():
                continue
            src = base64.b64encode(path.read_bytes()).decode("ascii")
            asset = _local(directory, item["path"])
            caption = "视频联系表" if item.get("kind") == "video" else "结果图"
            if item.get("width") and item.get("height"):
                caption += f" · {item['width']}×{item['height']}"
            image = f'<img src="data:image/jpeg;base64,{src}" alt="{_e(caption)}">'
            if asset.is_file() and asset.suffix.lower() in {
                ".png",
                ".jpg",
                ".jpeg",
                ".webp",
                ".gif",
                ".bmp",
                ".tiff",
                ".heif",
                ".avif",
                ".mp4",
                ".mov",
                ".m4v",
                ".webm",
                ".mkv",
            }:
                link = quote(Path(os.path.relpath(asset, page_dir)).as_posix())
                image = f'<a href="{link}">{image}</a>'
            figures.append(f"<figure>{image}<figcaption>{_e(caption)}</figcaption></figure>")
    return '<div class="media">' + "".join(figures) + "</div>" if figures else ""


def _source(row):
    mode = {"fake": "本机假上游", "real": "真实运行"}.get(row.get("provider_mode"), "来源未知")
    return mode + " · " + str(row.get("server_commit") or "提交未知")


def _incomplete(rows):
    return sum(row["status"] != "completed" for row in rows)


def _failure_reason(row):
    return row.get("reason") or next(
        (
            outcome.get("reason") or outcome["error"]
            for outcome in row.get("turn_outcomes", [])
            if outcome.get("reason") or outcome.get("error")
        ),
        "原因未知",
    )


def _overview(rows):
    counts = Counter(row["status"] for row in rows)
    status = " · ".join(f"{_e(STATES.get(k, k))} {v}" for k, v in counts.items())
    sources = "、".join(dict.fromkeys(_source(row) for row in rows))
    heading = ["运行", "未完成的运行数", "总体检查通过率"] + [
        "平均" + label for label, _ in METRICS.values()
    ]
    values = [str(len(rows)), str(_incomplete(rows)), _show_rate(_rate(rows, LABELS))]
    for key, (_, places) in METRICS.items():
        value = _number(_average(rows, key), places)
        n = sum(_metric(row, key) is not None for row in rows)
        values.append(f"{value} <small>({n}/{len(rows)})</small>" if n != len(rows) else value)
    rates = _table(list(LABELS.values()), [[_show_rate(_rate(rows, [key])) for key in LABELS]])
    return (
        f"<p>{_e(sources)} · 审查模式 · 脚本代替用户裁决 · {status}</p>"
        + _table(heading, [values])
        + "<h3>各项通过率</h3>"
        + rates
        + "<p><small>通过率仅计入可判定项，均值仅计入有记录的运行。</small></p>"
    )


def _usage(row):
    usage = row.get("usage") or {}
    source = {"estimated": "估价", "actual": "实扣", "settlement": "结算", "mixed": "混合口径"}.get(
        usage.get("chat_cost_source")
    )
    chat_label = f"对话费（{source}）/ 元" if source else "对话费 / 元"
    pairs = [(name, _number(_metric(row, key), places)) for key, (name, places) in METRICS.items()]
    pairs += [
        (
            "输入 / 输出 Token",
            f"{_number(usage.get('input_tokens'), 0)} / {_number(usage.get('output_tokens'), 0)}",
        ),
        (chat_label, _number(usage.get("chat_cost_cny"), 4)),
        ("生成费 / 元", _number(usage.get("generation_cost_cny"), 4)),
        ("裁决", len(row.get("approvals") or [])),
    ]
    return (
        '<div class="metrics">'
        + "".join(f"<span>{label} <b>{v}</b></span>" for label, v in pairs)
        + "</div>"
    )


def _check_label(key):
    number, separator, name = key.partition(".")
    return f"第 {number} 轮 · {LABELS[name]}" if separator else LABELS[key]


def _human_check(row):
    items = row.get("human_check") or []
    if not items:
        return ""
    return "<h3>人工评分要点</h3><ul>" + "".join(f"<li>{_e(item)}</li>" for item in items) + "</ul>"


def _case_html(root, row):
    directory = _local(root, row["directory"])
    status = STATES.get(row["status"], row["status"])
    body = [
        f"<article><header><h2>{_e(row.get('title') or row['case_id'])}</h2>"
        f"<span>{_e(status)}</span></header>",
        "<p>" + " · ".join(map(_e, (row["case_id"], row["surface"], row["chat_model"]))) + "</p>",
    ]
    body.append("<p>审查模式 · 脚本代替用户裁决</p>")
    if row["status"] != "completed":
        body.append(f'<p class="fail"><strong>未完成原因</strong>　{_e(_failure_reason(row))}</p>')
    body.extend([_usage(row), "<h3>需求</h3>"])
    for turn in row.get("turns") or []:
        body.append(f'<div class="copy">{_e(turn.get("say", ""))}</div>')
        if turn.get("attachments"):
            body.append(f"<p>附件 · {_e('、'.join(turn['attachments']))}</p>")
    body.append(_human_check(row))
    body.append(f'<h3>最终回复</h3><div class="copy">{_e(row.get("final_reply") or "—")}</div>')
    for job in row.get("generations") or []:
        body.append(
            f"<h3>{_e(job.get('model') or '未知模型')}</h3>" + _gallery(directory, [job], root)
        )
        body.append(
            "<p>估价 "
            + _number(job.get("estimated_cost_cny"), 4)
            + " 元 · 实际 "
            + _number(job.get("actual_cost_cny"), 4)
            + " 元</p>"
        )
        body.append(f'<div class="copy">{_e(job.get("prompt") or "—")}</div>')
        body.append(
            "<details><summary>生成参数与参考素材</summary>"
            + _pre(
                {
                    "params": job.get("params"),
                    "references": job.get("references"),
                    "status": job.get("status"),
                    "error": job.get("error"),
                }
            )
            + "</details>"
        )
    body.append(
        _table(
            ["检查", "结果", "依据"],
            [
                [_check_label(key), _verdict(grade), _e(grade["reason"])]
                for key, grade in row["checks"].items()
            ],
        )
    )
    body.append(
        "<details><summary>对话、工具与裁决</summary>"
        + _pre(
            {
                "messages": row.get("messages"),
                "steps": row.get("steps"),
                "approvals": row.get("approvals"),
                "usage": row.get("usage"),
                "unobservable": row.get("unobservable"),
            }
        )
        + "</details></article>"
    )
    return "".join(body)


def _identity(row):
    return row["case_id"], row["chat_model"]


def _csv_id(value):
    # Quoting alone does not stop spreadsheet applications evaluating a CSV cell.
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@", "'")) else value


def _scores(root):
    path = root / "scores.csv"
    if not path.exists():
        return {}
    with path.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        expected = ("case_id", "chat_model", *SCORE_FIELDS)
        if not set(expected) <= set(reader.fieldnames or []):
            raise ValueError("scores.csv 缺少需求、模型或评分列")
        return {_identity(row): {key: row[key] or "" for key in SCORE_FIELDS} for row in reader}


def write_report(out, rows):
    """Write a standalone HTML page, machine-readable evidence and manual scoring template."""
    out = Path(out)
    out.mkdir(exist_ok=True, parents=True)
    existing_scores = _scores(out)
    for row in rows:
        directory = _local(out, row["directory"])
        directory.mkdir(exist_ok=True, parents=True)
        _prepare_media(directory, row)
        row["checks"] = machine_checks(row)
        _dump_json(
            _local(directory, "transcript.json"),
            {
                k: row.get(k)
                for k in (
                    "turns",
                    "messages",
                    "steps",
                    "approvals",
                    "final_reply",
                    "status",
                    "turn_outcomes",
                    "reason",
                    "unobservable",
                )
            },
        )
    with (out / "results.jsonl").open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
    with (out / "scores.csv").open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.writer(file)
        writer.writerow(["case_id", "chat_model", *SCORE_FIELDS])
        for row in rows:
            identity = tuple(map(_csv_id, _identity(row)))
            score = existing_scores.get(identity, {})
            writer.writerow([*identity, *(score.get(k, "") for k in SCORE_FIELDS)])
    content = _overview(rows) + "".join(_case_html(out, row) for row in rows)
    (out / "index.html").write_text(_page("Agent 评测报告", content), encoding="utf-8")


def _read_run(directory):
    rows = {}
    with (directory / "results.jsonl").open(encoding="utf-8") as data:
        for line in data:
            if not line.strip():
                continue
            row = json.loads(line)
            key = _identity(row)
            if key in rows:
                raise ValueError("结果目录包含相同需求与对话模型的重复记录")
            rows[key] = row
    return rows


def _pair_table(table):
    """HTML and terminal tables use the exact same cells."""
    headers, *body = table
    html = _table(list(map(_e, headers)), [[_e(v) for v in row] for row in body])
    text = "\n".join("  |  ".join(" ".join(str(v).split()) for v in row) for row in table)
    return html, text


def _delta(before, after, places=2, unit=""):
    if before is None or after is None:
        return "—"
    change = after - before
    return ("+" if change > 0 else "") + _number(change, places) + unit


def _run_comparison(old, new):
    table = [["指标", "改造前", "改造后", "变化"]]
    before, after = _incomplete(old), _incomplete(new)
    table.append(["未完成的运行数", str(before), str(after), _delta(before, after, 0)])
    for label, keys in [("总体检查通过率", LABELS), *((v, [k]) for k, v in LABELS.items())]:
        a, b = _rate(old, keys), _rate(new, keys)
        pct_a = 100 * a[0] / a[1] if a[1] else None
        pct_b = 100 * b[0] / b[1] if b[1] else None
        table.append([label, _show_rate(a), _show_rate(b), _delta(pct_a, pct_b, 1, " 个百分点")])
    for key, (label, places) in METRICS.items():
        a, b = _average(old, key), _average(new, key)
        table.append(["平均" + label, _number(a, places), _number(b, places), _delta(a, b, places)])
    return table


def _compare_case(key, cases, scores):
    table = [["指标", "改造前", "改造后"]]
    table.append(
        ["运行状态", *(STATES.get(r["status"], r["status"]) if r else "缺少运行" for r in cases)]
    )
    if any(row and row["status"] != "completed" for row in cases):
        table.append(
            [
                "未完成原因",
                *(
                    _failure_reason(row) if row and row["status"] != "completed" else "—"
                    for row in cases
                ),
            ]
        )
    per_turn = []
    for row in cases:
        indexed = {}
        for name, grade in (row or {}).get("checks", {}).items():
            number, separator, check = name.partition(".")
            indexed[(int(number), check) if separator else (1, name)] = grade
        per_turn.append(indexed)
    multi = any(len((row or {}).get("turns", [])) > 1 for row in cases)
    labels = list(LABELS)
    for number, check in sorted(
        per_turn[0].keys() | per_turn[1].keys(), key=lambda k: (k[0], labels.index(k[1]))
    ):
        label = f"第 {number} 轮 · {LABELS[check]}" if multi else LABELS[check]
        pair = [grades.get((number, check)) for grades in per_turn]
        table.append([label, *(VERDICTS[g["status"]] if g else "—" for g in pair)])
    for metric, (label, places) in METRICS.items():
        table.append([label, *(_number(_metric(r, metric), places) if r else "—" for r in cases)])
    for field in SCORE_FIELDS:
        table.append(
            [
                field,
                *(
                    run_scores.get(tuple(map(_csv_id, key)), {}).get(field) or "—"
                    for run_scores in scores
                ),
            ]
        )
    return table


def compare(before, after, output):
    """Join two runs by case and chat model. Re-read scores each time for manual reviews."""
    roots = [Path(before), Path(after)]
    tables = [_read_run(root) for root in roots]
    scores = [_scores(root) for root in roots]
    output = Path(output)
    if output.is_dir() or output.suffix.lower() != ".html":
        output = output / "compare.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    common = [key for key in tables[0] if key in tables[1]]
    aggregated = _run_comparison(*([table[k] for k in common] for table in tables))
    heading = f"共同运行 {len(common)} 组 · 改造前 {len(tables[0])} 组 · 改造后 {len(tables[1])} 组"
    overview, plain = _pair_table(aggregated)
    source_rows = [
        ["运行", "上游与提交"],
        *[
            [label, "、".join(dict.fromkeys(_source(row) for row in run.values())) or "—"]
            for label, run in zip(["改造前", "改造后"], tables)
        ],
    ]
    source_html, source_text = _pair_table(source_rows)
    content = [f"<p>{heading}</p>", source_html, overview]
    text = [heading, source_text, plain]
    for key in dict.fromkeys([*tables[0], *tables[1]]):
        cases = [table.get(key) for table in tables]
        present = next(r for r in cases if r is not None)
        title = present.get("title") or key[0]
        content.append(f"<article><h2>{_e(title)}</h2><p>{_e(key[0])} · {_e(key[1])}</p>")
        content.append(_human_check(present))
        sides = []
        for label, root, row in zip(["改造前", "改造后"], roots, cases):
            media = (
                _gallery(
                    _local(root, row["directory"]), row.get("generations") or [], output.parent
                )
                if row
                else ""
            )
            sides.append(
                f"<section><h3>{label}</h3><p>{_e(_source(row)) if row else '—'}</p>"
                + (media or "<p>无结果图</p>")
                + "</section>"
            )
        content.append('<div class="pair">' + "".join(sides) + "</div>")
        detail, plain = _pair_table(_compare_case(key, cases, scores))
        content.extend([detail, "</article>"])
        text.append(f"{key[0]} · {key[1]}\n{plain}")
    output.write_text(_page("Agent 评测对照", "".join(content)), encoding="utf-8")
    return "\n\n".join(text)
