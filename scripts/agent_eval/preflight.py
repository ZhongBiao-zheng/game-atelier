"""Inspect the target checkout's local catalog and prices before enabling upstream access."""

from decimal import Decimal
import math

import requests


def _read(api, path, *, payload=None):
    response = api.get(path) if payload is None else api.post(path, json=payload)
    response.raise_for_status()
    return response.json()


def _priced(value):
    return type(value) in (float, int) and math.isfinite(value) and value >= 0


def _media_quotes(api):
    catalog = _read(api, "/api/canvas/agent/generation-models")["models"]
    quotes = {}
    for kind in ("image", "video"):
        params = {"n": 1}
        if kind == "video":
            params.update(duration=5, resolution="720p", ratio="16:9")
        items = [
            {"alias": row["alias"] or "@auto", "model": row["model"]}
            for row in catalog
            if row["kind"] == kind
        ]
        quotes[kind] = {}
        for start in range(0, len(items), 500):
            batch = items[start : start + 500]
            prices = _read(
                api,
                "/api/pricing/estimate-batch",
                payload={"kind": kind, "items": batch, "params": params},
            )
            for row in batch:
                alias, model = row["alias"], row["model"]
                quotes[kind][alias, model] = prices.get(f"{alias}:{model}")
    return quotes


def _needed_media(case):
    if case["limits"]["max_results"] == 0:
        return []
    expected = [case.get("expect", {}), *(turn.get("expect", {}) for turn in case["turns"])]
    kinds = [
        kind
        for kind, field in [("image", "images"), ("video", "videos")]
        if any(e.get(field, 0) > 0 for e in expected)
    ]
    if kinds:
        return kinds
    mode = case.get("settings", {}).get("creation_mode", "all")
    return [mode]  # With no explicit type, a priced image OR video supports an 'all' case.


def preflight(api, cases, models, budget, manifest_issues):
    issues = list(manifest_issues)
    lines = ["预检（离线，仅核对登记和本地价格）"]
    names = {
        name for case in cases for turn in case["turns"] for name in turn.get("attachments", [])
    }
    names.update(node["file"] for case in cases for node in case.get("canvas", {}).get("nodes", []))
    lines.append(
        f"需求 {len(cases)} 条，引用附件 {len(names)} 个。"
        + ("清单和附件见问题列表。" if issues else "附件齐全，字段均已识别。")
    )
    worst = sum((Decimal(str(c["limits"]["max_cost_cny"])) for c in cases), Decimal(0)) * len(
        models
    )
    lines.append(
        f"可解析需求的费用上限合计 × {len(models)} 个对话模型 = ¥{worst}，"
        + (f"预算 ¥{budget}。" if budget is not None else "未指定预算。")
    )
    if budget is not None and worst > budget:
        lines.append("最坏花费超过预算，矩阵可能提前收尾；累计达到预算的 90% 后停止开新需求。")

    try:
        # This endpoint may probe /models. The child denies DNS and outbound sockets
        # during preflight, so it returns only the checkout's locally registered candidates.
        registered = {
            (m["alias"], m["model"]) for m in _read(api, "/api/canvas/agent/models")["models"]
        }
        keys = {k["alias"]: k for k in _read(api, "/api/keys")["keys"]}
        # The API omits null rate fields on individual models. Check the advertised
        # schema to distinguish a known synced price from a checkout predating text pricing.
        schemas = _read(api, "/openapi.json").get("components", {}).get("schemas", {})
        rate_fields = {"input_cny_per_m", "output_cny_per_m"}
        supports_text_rates = any(
            rate_fields <= schema.get("properties", {}).keys() for schema in schemas.values()
        )
        for name in models:
            alias, model = name.split("/", 1)
            key = keys.get(alias, {})
            spec = next((m for m in key.get("models", []) if m["id"] == model), {})
            available = (alias, model) in registered and bool(key.get("access_key"))
            local = key.get("provider") != "atelier"
            manual = local and all(_priced(spec.get(f)) for f in rate_fields)
            # 'unpriced' is omitted for a known local synced rate. Old schemas without
            # the manual rate fields and gateway-only billing cannot certify a local rate.
            synced = (
                local and bool(spec) and supports_text_rates and spec.get("unpriced") is not True
            )
            source = "同步或内置价格" if synced else "手设价格" if manual else "无可核对价格"
            lines.append(f"对话 {name}：{'已登记' if available else '未登记或不可用'}，{source}。")
            if not available or not (synced or manual):
                issues.append(f"对话模型 {name} " + ("未登记或不可用" if not available else source))
    except (requests.RequestException, KeyError, ValueError, TypeError):
        issues.append("目标检出的对话模型或价格接口不可用，无法确认登记和价格。")

    lines.append("图片按默认尺寸一张，视频按 5 秒、720p、16:9 一段估价。")
    try:
        quotes = _media_quotes(api)
        for kind, label in [("image", "图片"), ("video", "视频")]:
            concrete = [(key, value) for key, value in quotes[kind].items() if key[0] != "@auto"]
            priced = sum(_priced(value) for _, value in concrete)
            lines.append(f"{label}模型 {len(concrete)} 个，其中 {priced} 个有单份估价。")
            for (alias, model), price in concrete:
                lines.append(f"  {alias}/{model}  " + (f"¥{price}" if _priced(price) else "未计价"))
        for case in cases:
            prefs = case.get("settings", {}).get("preferred_models", [])
            allowed = {
                tuple(p.split("/", 1))
                if isinstance(p, str)
                else (p["alias"] or "@auto", p["model"])
                for p in prefs
            }
            for kind in _needed_media(case):
                catalogs = quotes.values() if kind == "all" else [quotes[kind]]
                if not any(
                    _priced(price)
                    for catalog in catalogs
                    for key, price in catalog.items()
                    if not allowed or key in allowed
                ):
                    issues.append(f"{case['id']} 缺少可用且有估价的生成模型（{kind}）")
    except (requests.RequestException, KeyError, ValueError, TypeError):
        issues.append("目标检出的生成模型目录或估价接口不可用，无法确认生成价格。")

    for line in lines + [f"问题：{issue}" for issue in issues]:
        print(api.scrub(line))
    return not issues
