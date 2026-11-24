"""Request-only views of the canonical agent history."""
import json
from collections.abc import Callable

MEDIA_SCHEME = "atelier-media://"

RECENT_USER_TURNS = 2
FOLD_BATCH = 4
MAX_OUTPUT_CHARS = 800


def user_turn_starts(items: list) -> list[int]:
    return [i for i, item in enumerate(items) if isinstance(item, dict) and item.get("role") == "user"]


def hydrate_user_images(items: list, resolve: Callable[[str], str | None], missing: str) -> list:
    def image_part(part, recent):
        if not isinstance(part, dict) or part.get("type") != "input_image":
            return part
        url = part.get("image_url")
        if not isinstance(url, str) or not url.startswith(MEDIA_SCHEME):
            return part
        ref = url.removeprefix(MEDIA_SCHEME)
        if not recent:
            return {"type": "input_text", "text": f"[早期参考图已省略：media_ref={ref}，需要时调用 read_media]"}
        data_url = resolve(ref)
        if data_url is None:
            return {"type": "input_text", "text": missing}
        return {**part, "image_url": data_url}

    result = list(items)
    turns = user_turn_starts(items)
    for turn, start in enumerate(turns):
        item = items[start]
        if isinstance(item.get("content"), list):
            recent = turn >= len(turns) - RECENT_USER_TURNS
            result[start] = {**item, "content": [image_part(part, recent) for part in item["content"]]}
    return result


def _asset_refs(assets: list) -> list[dict]:
    rows = []
    for asset in assets:
        ref = asset.get("media_ref") or asset["asset_id"]
        if not isinstance(ref, str) or not isinstance(asset["title"], str):
            raise ValueError("invalid asset")
        if not asset.get("media_ref") and not ref.startswith(("asset:", "team:")):
            ref = "asset:" + ref
        rows.append({"media_ref": ref, "title": asset["title"]})
    return rows


def _run_fields(view: dict) -> dict:
    result = {key: view[key] for key in ("job_id", "run_id", "status", "media_ref", "error", "lookup_error")
              if view.get(key)}
    if not (result.get("job_id") or result.get("run_id")):
        raise ValueError("missing run identifier")
    for key in ("candidates", "outputs"):
        if key not in view:
            continue
        rows = []
        for row in view[key]:
            fields = {k: row[k] for k in ("status", "error", "media_ref") if row.get(k)}
            if row.get("version_id"):
                fields["media_ref"] = row["version_id"]
            if not fields:
                raise ValueError("missing result fields")
            rows.append(fields)
        result[key] = rows
    return result


def _summarize_output(name: str | None, output: str) -> str:
    try:
        data = json.loads(output)
        if not isinstance(data, dict):
            raise ValueError("expected an object")
        if name == "list_models" and isinstance(data.get("models"), list):
            return f"[已折叠早期模型列表（共 {len(data['models'])} 个），需要选型时重新调用 list_models]"
        if name == "get_canvas" and isinstance(data.get("nodes"), list):
            count = len(data["nodes"]) + data.get("omitted_nodes", 0)
            return f"[已折叠早期画布快照（共 {count} 个节点），以最新 get_canvas 为准]"
        if name in ("load_skill", "read_skill_file"):
            skills = data["skills"] if name == "load_skill" else [data]
            names = [row["name"] for row in skills if not row.get("error")]
            if names and len(names) == len(skills) and all(isinstance(n, str) and n for n in names):
                return f"[已加载技能 {'、'.join(names)}，需要细则时重新读取]"
        if name in ("search_library", "search_team") and isinstance(data.get("assets"), list):
            return json.dumps(_asset_refs(data["assets"]), ensure_ascii=False)
        if name in ("wait_for_run", "wait_for_runs", "get_run"):
            runs = data.get("runs")
            if isinstance(runs, dict):  # Studio keys wait results by job ID, including lookup errors.
                summary = [_run_fields({**view, "job_id": jid}) for jid, view in runs.items()]
            elif isinstance(runs, list):
                summary = [_run_fields(view) for view in runs]
            else:
                summary = _run_fields(data)
            return json.dumps(summary, ensure_ascii=False)
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        # Tool errors, truncated JSON and older output shapes still get a readable preview.
        pass
    return f"{output[:300]}…（原文 {len(output)} 字符，已折叠）"


def fold_tool_outputs(items: list) -> list:
    turns = user_turn_starts(items)
    boundary = max(0, (len(turns) - RECENT_USER_TURNS) // FOLD_BATCH * FOLD_BATCH)
    if not boundary:
        return items
    result = list(items)
    calls = {}
    # turns[boundary] starts the first retained user turn (zero-based).
    for index in range(turns[boundary]):
        item = items[index]
        if not isinstance(item, dict):
            continue
        call_id = item.get("call_id")
        if item.get("type") == "function_call":
            calls[call_id] = item.get("name")
        elif item.get("type") == "function_call_output":
            output = item.get("output")
            if isinstance(output, str) and len(output) > MAX_OUTPUT_CHARS:
                result[index] = {**item, "output": _summarize_output(calls.get(call_id), output)}
    return result
