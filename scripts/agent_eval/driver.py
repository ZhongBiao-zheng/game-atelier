"""Drive one Studio or Canvas session using the evaluated checkout's public HTTP API."""

from __future__ import annotations

import hashlib
import math
import mimetypes
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests

from .observations import (
    canvas_result,
    is_midjourney,
    media_evidence,
    per_turn_observation,
    requested_results,
    skills_from,
    steps_from,
    usage_from,
)

TERMINAL_JOBS = {"done", "partial", "failed", "canceled"}


class Unsupported(Exception):
    """An interface needed for this observation is missing in the evaluated checkout."""


def body(response, operation):
    if response.status_code in (404, 405, 501) or (
        response.ok and response.headers.get("Content-Type", "").startswith("text/html")
    ):
        raise Unsupported(operation)
    response.raise_for_status()
    return response.json()


def fixture_path(fixtures, name):
    path = (fixtures / name).resolve()
    if not path.is_relative_to(fixtures.resolve()) or not path.is_file():
        raise ValueError("找不到清单指定的附件")
    return path


def set_up(api, case, model, fixtures):
    studio = case["surface"] == "studio"
    settings = case.get("settings", {})
    alias, model_id = model.split("/", 1)
    preferred = settings.get("preferred_models", [])
    prefs = [
        {"alias": v.split("/", 1)[0], "model": v.split("/", 1)[1]} if isinstance(v, str) else v
        for v in preferred
    ]
    values = {
        "model_alias": alias,
        "model": model_id,
        "creation_mode": settings.get("creation_mode", "all"),
        "permission_mode": "review",  # Every case has a finite result cap, including fake runs.
        "auto_models": not bool(prefs),
        "preferred_models": prefs,
    }
    project = None
    if studio:
        base = "/api/studio/agent/sessions"
    else:
        project = body(
            api.post("/api/canvas/projects", json={"name": case["title"][:80]}), "画布项目"
        )
        project = "/api/canvas/projects/" + project["project_id"]
        base = project + "/agent/sessions"
        initial = case.get("canvas", {})
        if initial:
            seed_canvas(api, project, initial, fixtures)
    response = api.post(base, json={"title": case["title"][:80]})
    # Older local-session middlewares reject unregistered paths at the permission layer.
    if (
        response.status_code == 403
        and response.json().get("error", {}).get("code") == "CAPABILITY_DENIED"
    ):
        raise Unsupported("该检出目录未开放此工作区的 Agent 会话")
    session = body(response, "Agent 会话")
    url = base + "/" + session["session_id"]
    response = api.patch(url, json=values)
    omitted = []
    # Older servers may implement chat but lack newer optional settings. Retry only an
    # explicit schema rejection; never retry a message, approval or generation.
    if response.status_code == 422:
        defaults = {"preferred_models": [], "auto_models": True, "creation_mode": "all"}
        errors = response.json().get("detail")
        if isinstance(errors, list):
            for error in errors:
                field = (error.get("loc") or [None])[-1]
                if (
                    field in defaults
                    and values[field] == defaults[field]
                    and error.get("type") == "extra_forbidden"
                ):
                    omitted.append(field)
        if omitted:
            response = api.patch(url, json={k: v for k, v in values.items() if k not in omitted})
        if response.status_code == 422:
            raise Unsupported("此提交无法应用需求的会话设置")
    actual = body(response, "Agent 会话设置")
    for key, value in values.items():
        if key not in omitted and (key not in actual or actual[key] != value):
            raise Unsupported("此提交无法确认会话设置 " + key)
    threshold = settings.get("confirm_above_cny", 10)
    response = api.put("/api/canvas/agent/settings", json={"confirm_above_cny": threshold})
    if response.status_code in (404, 405) and values["permission_mode"] == "review":
        values["confirm_above_cny"] = None  # review still gates every generation
    else:
        values["confirm_above_cny"] = body(response, "确认金额设置").get("confirm_above_cny")
    for field in omitted:
        values[field] = None
    return url, project, values


def upload(api, url, path, **kwargs):
    with path.open("rb") as stream:
        form = {
            "file": (
                path.name,
                stream,
                mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            )
        }
        return body(api.post(url, files=form, **kwargs), "上传附件")


def seed_canvas(api, project, initial, fixtures):
    document = body(api.get(project + "/document"), "画布文档")
    nodes, ids, text_versions = [], [], {}
    for i, spec in enumerate(initial.get("nodes", [])):
        node = dict(spec)
        node_id = node.get("id") or "reference-" + uuid.uuid4().hex[:12]
        node.update(id=node_id, position=node.get("position", {"x": i * 280, "y": 0}))
        if "file" in node:
            path = fixture_path(fixtures, node.pop("file"))
            result = upload(
                api, project + "/uploads", path, data={"expected_revision": document["revision"]}
            )
            document = result["document"]
            version = result["version"]
            node.setdefault("type", version["kind"])
            node.setdefault("title", path.stem)
            node["data"] = {**node.get("data", {}), "current_version_id": version["version_id"]}
        elif node.get("type") == "text" and "text" in node:
            text = node.pop("text")
            vid = "txt-" + uuid.uuid4().hex[:16]
            text_versions[vid] = {
                "kind": "text",
                "text": text,
                "version_id": vid,
                "origin": {"kind": "user_edit"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
            node["data"] = {**node.get("data", {}), "current_version_id": vid}
        else:
            node.setdefault("data", {})
        ids.append(node_id)
        nodes.append(node)
    document["content_versions"].update(text_versions)
    document["nodes"].extend(nodes)
    document["connections"].extend(initial.get("connections", []))
    body(
        api.put(
            project + "/document", json=document, headers={"If-Match": str(document["revision"])}
        ),
        "写入初始画布",
    )
    return ids


def prepare_turn(api, url, project, turn, fixtures, row):
    files = turn.get("attachments", [])
    payload = {"text": turn["say"]}
    if project:
        ids = (
            seed_canvas(api, project, {"nodes": [{"file": name} for name in files]}, fixtures)
            if files
            else []
        )
        payload["node_ids"] = list(
            dict.fromkeys([*(row.get("canvas") or {}).get("selected", []), *ids])
        )
    else:
        payload["client_message_id"] = uuid.uuid4().hex
        payload["attachment_ids"] = [
            upload(api, url + "/attachments", fixture_path(fixtures, name))["attachment_id"]
            for name in files
        ]
    for name in files:
        digest = hashlib.sha256(fixture_path(fixtures, name).read_bytes()).hexdigest()
        if not any(a["name"] == name for a in row["attachments"]):
            row["attachments"].append({"name": name, "sha256": digest})
    return payload


def _single_quote(card):
    lines = (card.get("summary") or "").splitlines()
    if not lines:
        return []
    # Match the checkout's public formats structurally. Model names and prompts may
    # themselves contain currency-looking text; only read the designated price field.
    studio = re.fullmatch(r"1 项生成，预计 (\d+(?:\.\d+)?(?:[eE][+-]?\d+)?) 元", lines[0])
    if studio:
        price = float(studio[1])
        # Before Studio's second review the summary had the total only. The single
        # tool still submits one Job; keep its unknown output count explicitly null.
        count = re.search(r" · (\d+) 份 · ", lines[1]) if len(lines) > 1 else None
        name = lines[1].split(" · ", 1)[0] if count else None
        return [
            {
                "index": 0,
                "model": name,
                "estimate_cny": price,
                "count": int(count[1]) if count else None,
            }
        ]
    count = re.fullmatch(r"在节点 .+ 上生成 (\d+) 个结果", lines[0])
    if not count or len(lines) < 2:
        return []
    price = re.fullmatch(r".+ · 预计 (?:([0-9]+(?:\.[0-9]{1,2})?)|(<0\.01))¥", lines[1])
    if not price:
        return []
    amount = float(price[1]) if price[1] else 0.01
    # Keep the displayed estimate separate from its conservative budget bound.
    # Nonzero prices displayed to cents can round down by up to half a cent.
    upper = amount + 0.005 if price[1] and amount else amount
    return [
        {
            "index": 0,
            "model": lines[1].rsplit(" · ", 1)[0],
            "estimate_cny": amount,
            "budget_cny": upper,
            "count": int(count[1]),
        }
    ]


def decide(api, url, cards, money_left, count_left, turn_index, fixed_four=()):
    decisions, records = [], []
    for card in cards:
        tool, call = card["tool"], card["call_id"]
        decision = {"call_id": call, "approve": False}
        rows = []
        if tool == "run_generations":
            response = api.get(url + "/approvals/" + quote(call, safe="") + "/items")
            if response.ok:
                rows = response.json().get("items", [])
        elif tool == "run_generation":
            rows = _single_quote(card)
        else:
            # approve local canvas edits; arbitrary plugin tools can have external side effects
            decision["approve"] = tool in {"apply_changes", "update_plan"}
        accepted = []
        for item in rows:
            price = item.get("budget_cny", item.get("estimate_cny"))
            count = item.get("count")
            model = str(item.get("model") or "").lower().replace("_", "-")
            if model in fixed_four or is_midjourney(model):
                count = 4
            item["reserved_results"] = count
            if (
                isinstance(price, (float, int))
                and math.isfinite(price)
                and isinstance(count, int)
                and count > 0
                and 0 <= price <= money_left + 1e-9
                and count_left >= count
            ):
                accepted.append(item["index"])
                money_left -= price
                count_left -= count
        if accepted:
            decision["approve"] = True
            if tool == "run_generations" and len(accepted) != len(rows):
                decision["items"] = accepted
        decisions.append(decision)
        records.append(
            {
                "turn_index": turn_index,
                "tool": tool,
                "call_id": call,
                "summary": card.get("summary"),
                "items": rows,
                "approved": decision["approve"],
                "accepted_indices": accepted,
                "reason": "within_limits"
                if decision["approve"]
                else "over_limit_or_unpriced"
                if tool.startswith("run_generation")
                else "unknown_write",
            }
        )
    return decisions, records


def occupied_results(jobs):
    """Terminal jobs count delivered images/clips; outstanding submissions reserve their whole quantity."""
    total = 0
    for job in jobs:
        if job.get("kind", "image") not in {"image", "video"}:
            continue
        delivered = len(job.get("output_paths") or [])
        if job.get("status") in TERMINAL_JOBS:
            total += delivered
        else:
            candidates = (job.get("canvas_run") or {}).get("candidates") or []
            total += max(
                delivered,
                len(candidates),
                (job.get("params") or {}).get("n") or 1,
                job.get("_reserved_results", 0),
            )
    return total


def _jobs(api, project, url):
    response = api.get(project + "/jobs" if project else url + "/jobs")
    if response.status_code in (404, 405):
        all_jobs = body(api.get("/api/jobs"), "关联生成任务")
        return [
            job
            for job in all_jobs
            if (
                job.get("canvas_project_id") == project.rsplit("/", 1)[1]
                if project
                else job.get("studio_agent_session_id") == url.rsplit("/", 1)[1]
            )
        ]
    result = body(response, "关联生成任务")
    return result if isinstance(result, list) else result["jobs"]


def _read_with_quotes(api, project, url, quotes):
    jobs = _jobs(api, project, url)
    for job in jobs:
        entry = quotes.setdefault(job["job_id"], {})
        job.update(entry)
        count = requested_results(job)
        if count is not None:
            entry.setdefault("_requested_results", count)
    return jobs


def remember_quotes(jobs_before, jobs_after, records, quotes):
    # The approvals POST applies its selected items before returning. With distinct prices
    # and multiple new Jobs the old API has no explicit quote-to-Job link, so do not guess.
    ids = {job["job_id"] for job in jobs_before}
    new_ids = [job["job_id"] for job in jobs_after if job["job_id"] not in ids]
    accepted = [
        item
        for record in records
        for item in record["items"]
        if item["index"] in record["accepted_indices"]
    ]
    prices = {item["estimate_cny"] for item in accepted}
    sizes = sorted((item["reserved_results"] for item in accepted), reverse=True)
    new_jobs = {j["job_id"]: j for j in jobs_after if j["job_id"] in new_ids}
    for jid, job in new_jobs.items():
        entry = quotes.setdefault(jid, {})
        # Exact submission evidence is distinct from the upper bound reserved below.
        count = requested_results(job)
        if count is None and sizes and len(set(sizes)) == 1 and len(new_jobs) <= len(accepted):
            count = sizes[0]
        if count is not None:
            entry.setdefault("_requested_results", count)
        if len(prices) == 1 and len(new_ids) == len(accepted):
            entry["_approval_estimate"] = next(iter(prices))
        if sizes and (
            len(set(sizes)) == 1
            or not (
                (job.get("params") or {}).get("n")
                or (job.get("canvas_run") or {}).get("candidates")
            )
        ):
            entry["_reserved_results"] = sizes[0]
    return sum(sizes[: max(0, len(accepted) - len(new_ids))])


def model_returned(session):
    # The product records an empty completed response as failed after its usage hook runs.
    return session.get("status") in {"idle", "awaiting_approval"} or (
        session.get("status") == "failed"
        and (session.get("error") or "").startswith("模型没有返回内容，可以重试或换个模型")
    )


def request_may_be_in_flight(session):
    status = session.get("status")
    if model_returned(session):
        return False
    if status in {"failed", "interrupted"}:
        # These messages identify a local step limit or an explicit provider rejection.
        # A terminal HTTP 5xx, an SSE error frame, or a truncated response can follow
        # real processing without triggering the SDK's end-of-response usage hook.
        error = session.get("error") or ""
        rejected = re.match(r"对话模型返回错误 (400|401|403|404|405|413|415|422|429)[：:]", error)
        return not (rejected or error.startswith("这一轮步骤太多，已停下"))
    return True


def stop_work(api, url, project, jobs, notices, in_flight, *, unknown_delivery=False):
    # Cancel the model first so a new Job cannot appear between listing and cancellation.
    confirmed = True
    if url:
        try:
            before = body(api.get(url), "停止前读取轮次")
        except (requests.RequestException, Unsupported, ValueError):
            before = {}
        else:
            in_flight = request_may_be_in_flight(before)
        try:
            if before.get("status") not in {"idle", "failed", "interrupted"}:
                stopped = body(api.post(url + "/cancel", json={}), "停止轮次")
                if stopped.get("status") not in {"idle", "interrupted", "failed"}:
                    confirmed = False
                    notices.add("停止轮次未获确认")
        except (requests.RequestException, Unsupported, ValueError):
            confirmed = False
            notices.add("停止轮次未获确认")
        try:
            jobs = _jobs(api, project, url)
        except (requests.RequestException, Unsupported, ValueError):
            confirmed = False
            notices.add("停止时无法刷新作业列表")
    for job in jobs:
        if job.get("status") not in TERMINAL_JOBS:
            endpoint = (
                project + "/runs/" + job["canvas_run"]["run_id"]
                if project
                else "/api/jobs/" + job["job_id"]
            )
            try:
                api.post(endpoint + "/cancel", json={}).raise_for_status()
            except requests.RequestException:
                confirmed = False
                notices.add("停止请求未获确认，已提交任务可能继续计费")
    return confirmed and not in_flight and not unknown_delivery


def run_case(
    api, case: dict, model: str, fixtures: Path, directory: Path, remaining: float | None
) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    limits = case["limits"]
    max_money = (
        limits["max_cost_cny"] if remaining is None else min(remaining, limits["max_cost_cny"])
    )
    row = {
        "case_id": case["id"],
        "chat_model": model,
        "title": case["title"],
        "surface": case["surface"],
        "turns": case["turns"],
        "expect": case.get("expect", {}),
        "attachments": [],
        "approvals": [],
        "generations": [],
        "messages": [],
        "steps": [],
        "status": "completed",
        "reason": "",
        "available_skills": None,
        "loaded_skills": None,
        "final_reply": "",
        "settings": case.get("settings", {}),
        "limits": limits,
        "human_check": case.get("human_check", []),
        "canvas": case.get("canvas"),
        "turn_outcomes": [],
    }
    notices, jobs, session, usage, job_turn = set(), [], {}, {}, {}
    quotes = {}
    pending_quote = None
    unmatched_results = 0
    canvas_marks = {}
    project = url = None
    turn_index = 0
    # Set before sending a request that may start billable work. A timeout can mean
    # the server already accepted it. An observed quiescent session clears the flag.
    model_may_be_running = False
    waiting_for_submission_reply = False
    settlement_uncertain = False
    usage_gap = False
    segment_start_requests = None

    def observe_usage(current, session_state):
        nonlocal usage, usage_gap
        # Each user message/approval starts a fresh model run. Compare also during the
        # run, so an earlier priced response cannot hide a later response with zero usage.
        fields = ("requests", "input_tokens", "output_tokens")
        if all(isinstance(current.get(k), int) and isinstance(usage.get(k), int) for k in fields):
            if current["requests"] > usage["requests"] and all(
                current[k] == usage[k] for k in fields[1:]
            ):
                usage_gap = True
                notices.add("对话请求数增加，但没有登记这次请求的 token 用量")
            if (
                model_returned(session_state)
                and segment_start_requests is not None
                and current["requests"] <= segment_start_requests
            ):
                usage_gap = True
                notices.add("模型轮次已返回，但没有登记本轮的用量记录")
        usage = current

    def interrupt_case():
        nonlocal settlement_uncertain
        row.update(status="stopped", reason="interrupted")
        settlement_uncertain = True
        notices.add("评测被中断，金额仅含已观察到的用量及生成估价")
        if url:
            stop_work(api, url, project, jobs, notices, model_may_be_running)

    try:
        url, project, applied = set_up(api, case, model, fixtures)
        row["effective_settings"] = applied
        response = api.get("/api/canvas/agent/skills")
        if response.ok:
            row["available_skills"] = [s["name"] for s in response.json().get("skills", [])]
        else:
            notices.add("此提交未提供技能目录")
        jobs = _jobs(api, project, url)
        catalog = api.get("/api/canvas/agent/generation-models")
        fixed_four = set()
        if catalog.ok:
            for spec in catalog.json().get("models", []):
                mid = spec["model"].lower().replace("_", "-")
                if is_midjourney(mid):
                    fixed_four.update({mid, spec["name"].lower().replace("_", "-")})
        # Verify observation & stop prerequisites before sending a paid message.
        response = api.get(url + "/usage")
        required_usage = {"requests", "cost_cny", "unpriced"}
        if remaining is not None and (
            not response.ok or not required_usage.issubset(response.json())
        ):
            raise Unsupported("缺少对话用量接口，无法约束真实预算")
        usage = response.json() if response.ok else {}
        for turn_index, turn in enumerate(case["turns"], 1):
            payload = prepare_turn(api, url, project, turn, fixtures, row)
            if time.monotonic() - start >= limits["max_seconds"]:
                row.update(status="stopped", reason="max_seconds")
                break
            model_may_be_running = True
            waiting_for_submission_reply = True
            segment_start_requests = usage.get("requests")
            session = body(api.post(url + "/messages", json=payload), "发送对话")
            waiting_for_submission_reply = False
            while True:
                session = body(api.get(url), "读取会话")
                model_may_be_running = request_may_be_in_flight(session)
                jobs = _read_with_quotes(api, project, url, quotes)
                for job in jobs:
                    job_turn.setdefault(job["job_id"], turn_index)
                response = api.get(url + "/usage")
                if response.ok:
                    observe_usage(response.json(), session)
                    if remaining is not None and not required_usage.issubset(usage):
                        raise Unsupported("对话用量缺少计价字段")
                elif remaining is not None:
                    raise Unsupported("对话用量不可读")
                else:
                    notices.add("会话用量不可读")
                spent = usage_from(usage, jobs, session)
                status = session.get("status")
                steps = steps_from(session)
                cards = session.get("pending_approvals", [])
                count = occupied_results(jobs)
                step_count = max(len(steps), usage.get("requests", 0))
                reason = None
                if spent["total_cost_cny"] > max_money + 1e-9:
                    reason = (
                        "budget_exceeded"
                        if remaining is not None and spent["total_cost_cny"] > remaining
                        else "max_cost_cny"
                    )
                elif (
                    remaining is not None
                    and usage_gap
                    and not (status == "idle" and turn_index == len(case["turns"]))
                ):
                    reason = "unpriced_chat"
                elif remaining is not None and usage.get("unpriced") and not spent["cost_complete"]:
                    reason = "unpriced_chat"
                elif (
                    remaining is not None
                    and spent["generation_cost_cny"] is None
                    and (cards or all(j["status"] in TERMINAL_JOBS for j in jobs))
                ):
                    reason = "unpriced_generation"
                elif (
                    sum(
                        len(j.get("output_paths") or [])
                        for j in jobs
                        if j.get("kind", "image") in {"image", "video"}
                    )
                    > limits["max_results"]
                ):
                    reason = "max_results"
                elif step_count > limits["max_steps"] or (
                    step_count == limits["max_steps"] and status in ("awaiting_approval", "running")
                ):
                    reason = "max_steps"
                elif time.monotonic() - start >= limits["max_seconds"]:
                    reason = "max_seconds"
                if reason:
                    row.update(status="stopped", reason=reason)
                    settlement_uncertain = not stop_work(
                        api, url, project, jobs, notices, model_may_be_running
                    )
                    break
                if status == "awaiting_approval":
                    if not cards:
                        raise Unsupported("缺少确认卡")
                    decisions, records = decide(
                        api,
                        url,
                        cards,
                        max_money - spent["total_cost_cny"],
                        limits["max_results"] - count - unmatched_results,
                        turn_index,
                        fixed_four,
                    )
                    row["approvals"].extend(records)
                    pending_quote = (jobs, records)
                    model_may_be_running = True
                    waiting_for_submission_reply = True
                    segment_start_requests = usage.get("requests")
                    body(
                        api.post(url + "/approvals", json={"decisions": decisions}, timeout=120),
                        "提交裁决",
                    )
                    waiting_for_submission_reply = False
                    if any(r["accepted_indices"] for r in records):
                        unmatched_results += remember_quotes(
                            jobs, _jobs(api, project, url), records, quotes
                        )
                    pending_quote = None
                elif status in ("failed", "interrupted"):
                    row.update(
                        status="failed" if status == "failed" else "stopped",
                        reason=session.get("error") or f"session_{status}",
                    )
                    settlement_uncertain = not stop_work(
                        api, url, project, jobs, notices, model_may_be_running
                    )
                    break
                elif status == "idle" and all(j["status"] in TERMINAL_JOBS for j in jobs):
                    break
                elif status not in ("running", "idle"):
                    raise Unsupported("未知会话状态")
                time.sleep(0.15)
            if project and jobs:
                response = api.get(project + "/document")
                document = response.json() if response.ok else None
                for job in jobs:
                    if job_turn.get(job["job_id"]) == turn_index:
                        canvas_marks[job["job_id"]] = canvas_result(
                            job, document, (case.get("canvas") or {}).get("selected", [])
                        )
            row["turn_outcomes"].append(
                {
                    "turn_index": turn_index,
                    "status": row["status"],
                    "session_status": session.get("status"),
                    "reason": row["reason"],
                    "error": session.get("error"),
                }
            )
            if row["status"] != "completed":
                break
    except KeyboardInterrupt:
        interrupt_case()
    except (Unsupported, requests.RequestException, ValueError, KeyError, OSError) as error:
        row.update(
            status="not_applicable" if isinstance(error, Unsupported) else "failed",
            reason=str(error)
            if isinstance(error, (Unsupported, ValueError))
            else f"{type(error).__name__}（HTTP {getattr(getattr(error, 'response', None), 'status_code', '未知')}）",
        )
        if url:
            try:
                settlement_uncertain = not stop_work(
                    api,
                    url,
                    project,
                    jobs,
                    notices,
                    model_may_be_running,
                    unknown_delivery=waiting_for_submission_reply,
                )
            except KeyboardInterrupt:
                interrupt_case()

    def collect():
        nonlocal jobs, session, usage, settlement_uncertain
        if url:
            try:
                session = body(api.get(url), "会话")
                jobs = _read_with_quotes(api, project, url, quotes)
                if pending_quote:
                    before, records = pending_quote
                    remember_quotes(before, jobs, records, quotes)
                    for job in jobs:
                        job.update(quotes.get(job["job_id"], {}))
                response = api.get(url + "/usage")
                if not response.ok:
                    raise Unsupported("对话用量")
                observe_usage(response.json(), session)
                if session.get("status") not in {"idle", "interrupted", "failed"}:
                    settlement_uncertain = True
            except (requests.RequestException, Unsupported, ValueError, KeyError):
                if turn_index:
                    settlement_uncertain = True
                notices.add("结束时未能获取完整的会话、生成或用量")
        row["steps"] = steps_from(session)
        row["messages"] = session.get("messages", [])
        for message in reversed(row["messages"]):
            if message.get("role") == "user":
                break
            if message.get("role") == "assistant" and message.get("text"):
                row["final_reply"] = message["text"]
                break
        row["step_count"] = max(len(row["steps"]), usage.get("requests", 0))
        row["validation_errors"] = sum(
            bool(
                re.search(
                    "参数错误|参数不合规|validation error",
                    str(step.get("result") or ""),
                    flags=re.IGNORECASE,
                )
            )
            for step in row["steps"]
        )
        row["loaded_skills"] = skills_from(row["steps"]) if session else None
        if session and "history" not in session:
            notices.add("该会话接口仅返回可见工具步骤与摘要，未公开的原始工具参数记为 null")
        collected = {entry["job_id"] for entry in row["generations"]}
        for index, job in enumerate(sorted(jobs, key=lambda j: j.get("submitted_at", "")), 1):
            if job["job_id"] in collected:
                continue
            tid = job.get("studio_agent_turn_id")
            session_index = next(
                (
                    i
                    for i, t in enumerate(session.get("turns", []), 1)
                    if tid and t.get("turn_id") == tid
                ),
                None,
            )
            number = session_index or job_turn.get(job["job_id"], turn_index or None)
            evidence = media_evidence(api, job, directory, index, number, notices)
            if project:
                evidence.update(
                    canvas_marks.get(job["job_id"], {"on_canvas": None, "canvas_evidence": None})
                )
            row["generations"].append(evidence)
        recorded = {turn["turn_index"] for turn in row["turn_outcomes"]}
        if (
            turn_index
            and turn_index not in recorded
            and (model_may_be_running or row["reason"] == "interrupted")
        ):
            row["turn_outcomes"].append(
                {
                    "turn_index": turn_index,
                    "status": row["status"],
                    "reason": row["reason"],
                    "session_status": session.get("status"),
                    "error": session.get("error"),
                }
            )
        for outcome in row["turn_outcomes"]:
            number = outcome["turn_index"]
            names = row["turns"][number - 1].get("attachments", [])
            outcome.update(
                per_turn_observation(
                    session,
                    row["steps"],
                    [a for a in row["attachments"] if a["name"] in names],
                    number,
                )
            )
            if project:
                marks = [
                    job.get("on_canvas")
                    for job in row["generations"]
                    if job["turn_index"] == number
                ]
                outcome["on_canvas"] = (
                    False if False in marks else None if None in marks else bool(marks)
                )

        row["usage"] = usage_from(usage, jobs, session)
        if row["status"] == "not_applicable" and not row["messages"] and not jobs:
            row["usage"]["cost_complete"] = turn_index == 0
        if usage.get("source") in {"lan", "mixed"} and usage.get("unpriced"):
            notices.add("网关会话汇总未区分已结算与仍待结算的请求，无法确认总额")
        if usage_gap:
            row["usage"]["cost_complete"] = False
        if settlement_uncertain:
            row["usage"]["cost_complete"] = False
            notices.add("请求可能仍在结算，当前合计仅含已观测到的费用")
        if any(job.get("status") not in TERMINAL_JOBS for job in jobs):
            notices.add("停止时仍有已提交任务，最终结算金额未知")
            row["usage"]["cost_complete"] = False
        if (
            row["reason"] != "interrupted"
            and remaining is not None
            and row["usage"]["total_cost_cny"] > remaining
        ):
            row.update(status="stopped", reason="budget_exceeded")
        row["elapsed_seconds"] = round(time.monotonic() - start, 3)
        row["unobservable"] = sorted(notices)
        return row

    try:
        return collect()
    except KeyboardInterrupt:
        # This can also happen while retrieving the final bill or saving a result.
        interrupt_case()
        return collect()
