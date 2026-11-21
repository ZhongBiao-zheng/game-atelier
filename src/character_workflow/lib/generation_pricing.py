"""Synchronous CNY estimates, kept in parity with web/lib/generationCost.ts.

Unknown channels/models remain unpriced. Prices are packaged resources shared
with the frontend; never infer a price from a similarly named model.
"""
from __future__ import annotations

import json
import math
import re
from importlib.resources import files
from typing import Any
from urllib.parse import urlsplit

_PRICES = json.loads(
    files("character_workflow").joinpath("data/generation_prices.json").read_text(encoding="utf-8")
)

_MODERN_DIMENSIONS = {
    "480p": [(864, 496), (752, 560), (640, 640), (560, 752), (496, 864), (992, 432)],
    "720p": [(1280, 720), (1112, 834), (960, 960), (834, 1112), (720, 1280), (1470, 630)],
    "1080p": [(1920, 1080), (1664, 1248), (1440, 1440), (1248, 1664), (1080, 1920), (2206, 946)],
}
_LEGACY_DIMENSIONS = {
    "480p": [(864, 480), (736, 544), (640, 640), (544, 736), (480, 864), (960, 416)],
    "720p": [(1248, 704), (1120, 832), (960, 960), (832, 1120), (704, 1248), (1504, 640)],
    "1080p": [(1920, 1088), (1664, 1248), (1440, 1440), (1248, 1664), (1088, 1920), (2176, 928)],
}
_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]


def _normalize(value: str | None) -> str:
    return re.sub(r"[._]", "-", (value or "").strip().lower())


def _hostname(base_url: str | None) -> str:
    try:
        parsed = urlsplit(base_url or "")
        return (parsed.hostname or "").lower() if parsed.scheme else ""
    except ValueError:
        return ""


def _domain(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def _priced(amount: float) -> float:
    # JS Math.round (positive money), rather than Python's ties-to-even round.
    return math.floor(amount * 1_000_000 + 0.5) / 1_000_000


def _pixels(size: str | None) -> tuple[int, int] | None:
    match = re.fullmatch(r"([0-9]+)x([0-9]+)", (size or "").strip())
    return (int(match[1]), int(match[2])) if match else None




def _ark_seedream_rate(entry: Any, size: str | None) -> float | None:
    """火山直连 Seedream 单价：数字为单一价；`[[像素上限, 单价], ...]` 按输出总像素选档（上限含）。"""
    if not isinstance(entry, list):
        return entry
    pixels = _pixels(size)
    if pixels is None:
        return None
    total = pixels[0] * pixels[1]
    return next((rate for upper, rate in entry if total <= upper), None)


def _rate(value: Any) -> float | None:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return None
    return rate if math.isfinite(rate) and rate >= 0 else None


def _pricing_item(items: list[dict], suffixes: tuple[str, ...]) -> dict | None:
    return next((item for item in items if str(item.get("id", "")).endswith(suffixes)), None)


def _plan_rate(item: dict | None, dimensions: tuple[int, int] | None) -> float | None:
    """按张计价项的单价；带 `range` 的按输出千像素分段。不知道尺寸时只有各档同价才能定价。"""
    plans = [plan for plan in (item or {}).get("plans") or []
             if isinstance(plan, dict) and plan.get("unit") == "images"]
    kpixels = dimensions[0] * dimensions[1] / 1000 if dimensions else None

    def fits(plan: dict) -> bool:
        bounds = plan.get("range")
        if not isinstance(bounds, dict) or kpixels is None:
            return True
        return (float(bounds.get("lower", 0)) <= kpixels
                and ("upper" not in bounds or kpixels < float(bounds["upper"])))

    rates = {_rate(plan.get("rate")) for plan in plans if fits(plan)}
    return rates.pop() if len(rates) == 1 and None not in rates else None


def layer_decomposition_cost_cny(provider: str | None, model_id: str, result: dict) -> float | None:
    """图层拆分完成后按厂商回传结算：每层按其输出尺寸计一张生成图，另加输入图费用。

    拆分前不知道层数，只能事后算。目前只有 TokenDance 有可核对的价格快照，其他渠道返回 None。
    """
    if _normalize(provider) != "tokendance":
        return None
    from character_workflow.lib.tokendance_prices import model_pricing

    items = [item for item in (model_pricing(model_id) or {}).get("items") or []
             if isinstance(item, dict)]
    outputs = result.get("outputs") or []
    usage = result.get("usage") or {}
    if not outputs or usage.get("generated_images") not in (None, len(outputs)):
        return None
    generated = _pricing_item(items, ("generated_images", ":images"))
    total = 0.0
    for output in outputs:
        rate = _plan_rate(generated, _pixels(output.get("size")))
        if rate is None or _pixels(output.get("size")) is None:
            return None
        total += rate
    inputs = usage.get("input_images") or 0
    if inputs:
        rate = _plan_rate(_pricing_item(items, ("input_images",)), None)
        if rate is None:
            return None
        total += rate * inputs
    return _priced(total)


def _tokendance(*, kind, model_id, n, size, duration, resolution, ratio, has_reference_video,
                generate_audio=False):
    """按 TokenDance 价格快照估价：图片按张（可按输出千像素分段），视频按输出 token 或按秒。"""
    from character_workflow.lib.tokendance_prices import model_pricing

    pricing = model_pricing(model_id)
    items = [item for item in (pricing or {}).get("items") or [] if isinstance(item, dict)]
    if kind == "image":
        rate = _plan_rate(_pricing_item(items, ("generated_images", ":images")), _pixels(size))
        return None if rate is None else _priced(rate * n)
    if duration is None or not math.isfinite(duration) or duration <= 0:
        return None
    res = (resolution or "").strip().lower()
    video = "true" if has_reference_video else "false"
    # 可灵按「输入视频秒 + 输出秒」两段计费：带参考视频时拿不到输入时长，不估。
    if has_reference_video and any(str(item.get("id", "")).endswith(":video_input_seconds")
                                   for item in items):
        return None
    feature = "video_reference" if has_reference_video else (
        "sound" if generate_audio else "silent")
    candidates = []
    for item in items:
        item_id = str(item.get("id", ""))
        # 输入视频计费与动作控制是另外的计费项，不是这次生成的单价。
        if item_id.endswith(":video_input_seconds") or "motion-control" in item_id:
            continue
        for sku in item.get("skus") or []:
            specs = sku.get("specs") or {} if isinstance(sku, dict) else {}
            sku_res = str(specs.get("resolution", "*")).lower()
            if sku_res not in ("*", res) or specs.get("has_video", video) != video:
                continue
            if specs.get("feature", feature) != feature:
                continue
            candidates.append(((sku_res != "*") + ("feature" in specs), sku))
    if not candidates:
        return None
    sku = max(candidates, key=lambda pair: pair[0])[1]  # 指定分辨率 / 特性的价格优先于通配
    rate = _rate(sku.get("rate"))
    if rate is None:
        return None
    if sku.get("unit") == "seconds":
        return _priced(rate * duration * n)
    if sku.get("unit") == "millionTokens":
        aspect = (ratio or "").strip()
        if res not in _MODERN_DIMENSIONS or aspect not in _RATIOS:
            return None
        width, height = _MODERN_DIMENSIONS[res][_RATIOS.index(aspect)]
        return _priced(duration * width * height * 24 / 1024 * rate * n / 1_000_000)
    return None


def _tokendance_character_rate(model_id: str) -> float | None:
    """TokenDance 语音的「元 / 千字」单价：同步接口的按字符计费项；流式与音色复刻不算。"""
    from character_workflow.lib.tokendance_prices import model_pricing

    items = [item for item in (model_pricing(model_id) or {}).get("items") or []
             if isinstance(item, dict)]
    rates = {
        _rate(plan.get("rate"))
        for item in items
        if str(item.get("id", "")).endswith(":characters")
        and "_ws:" not in str(item.get("id", "")) and "voice_clone" not in str(item.get("id", ""))
        for plan in item.get("plans") or []
        if isinstance(plan, dict) and plan.get("unit") == "kCharacters"
    }
    return rates.pop() if len(rates) == 1 and None not in rates else None


def speech_cost_cny(*, provider: str | None, model_id: str, characters: int) -> float | None:
    """按字符计费的语音：预估用朗读文本字数，实付用上游回报的计费字数。只认有价格快照的渠道。"""
    if _normalize(provider) != "tokendance" or characters < 0:
        return None
    rate = _tokendance_character_rate(model_id)
    return None if rate is None else _priced(rate * characters / 1000)


def music_cost_cny(*, provider: str | None, model_id: str, songs: int) -> float | None:
    """按首计费的音乐（TokenDance `songs`）：预估按请求首数，实付按成功下载的首数。"""
    if _normalize(provider) != "tokendance" or songs < 0:
        return None
    from character_workflow.lib.tokendance_prices import model_pricing

    items = [item for item in (model_pricing(model_id) or {}).get("items") or []
             if isinstance(item, dict)]
    rates = {
        _rate(plan.get("rate"))
        for item in items
        if str(item.get("id", "")).endswith(":song:songs")
        for plan in item.get("plans") or []
        if isinstance(plan, dict) and plan.get("unit") == "songs"
    }
    rate = rates.pop() if len(rates) == 1 and None not in rates else None
    return None if rate is None else _priced(rate * songs)


def estimate_cost_cny(
    *, kind: str, provider: str | None = None, base_url: str | None = None,
    billing_group: str | None = None, model_id: str | None = None,
    protocol: str | None = None, n: float | None = 1, size: str | None = None,
    size_mode: str | None = None, quality: str | None = None, duration: float | None = None,
    resolution: str | None = None, ratio: str | None = None, generate_audio: bool = False,
    has_reference_video: bool = False, image_edit: bool = False,
    reference_image_count: int = 0, layer_decomposition: bool = False,
    text_length: int | None = None,
) -> float | None:
    """Estimate one generation request; None means no verified price."""
    # 自定义接口一律未计价：模型 id 与地址可能恰好撞上内置渠道，不能套用内置价格（ADR-0036）。
    if not model_id or _normalize(protocol) == "declarative":
        return None
    if kind == "audio":
        from character_workflow.lib.audio_caps import AUDIO_CAPS

        caps = AUDIO_CAPS.get(protocol or "")
        if caps is not None and caps.family == "music":
            songs = max(1, min(caps.max_count, math.floor(n))) if n is not None and math.isfinite(n) else 1
            return music_cost_cny(provider=provider, model_id=model_id, songs=songs)
        return None if text_length is None else speech_cost_cny(
            provider=provider, model_id=model_id, characters=text_length)
    if provider == "comfyui":
        return 0.0 if kind == "image" else None
    if provider == "chatgpt":
        return 0.0 if kind == "image" and model_id == "gpt-image-2" else None
    count = max(1, math.floor(n)) if n is not None and math.isfinite(n) else 1
    model = _normalize(model_id)
    host = _hostname(base_url)
    proto = _normalize(protocol)
    p = _PRICES
    ark = host == "ark.cn-beijing.volces.com" if (base_url or "").strip() else (
        _normalize(provider) in ("seedream", "seedance", "volces", "volcengine-video")
    )
    if kind == "image":
        if provider == "evolink":
            if (host and host != "api.evolink.ai") or model_id != "mj-v8.2" or (
                proto and proto != "evolink"
            ):
                return None
            route = "imageEdit" if image_edit else "generation"
            return _priced(p["EVOLINK_MIDJOURNEY_USD_PER_REQUEST"][route]
                           * p["GENERATION_USD_TO_CNY"])
        if _domain(host, "tu-zi.com"):
            from character_workflow.lib.tuzi_estimate import estimate

            return estimate(model_id=model_id, provider=provider, base_url=base_url,
                            billing_group=billing_group, protocol=protocol, n=count,
                            size=size, quality=quality, reference_image_count=reference_image_count,
                            layer_decomposition=layer_decomposition)
        if _domain(host, "openai-hk.com") and proto in ("", "openai"):
            from character_workflow.lib.openai_hk_prices import estimate

            return None if layer_decomposition else estimate(
                model_id=model_id, n=count, billing_group=billing_group,
            )
        elif _normalize(provider) == "tokendance":
            return _tokendance(kind=kind, model_id=model_id, n=count, size=size, duration=duration,
                               resolution=resolution, ratio=ratio,
                               has_reference_video=has_reference_video)
        elif ark and proto in ("", "ark"):
            rate = _ark_seedream_rate(p["ARK_SEEDREAM_YUAN_PER_IMAGE"].get(model), size)
        else:
            return None
        return None if rate is None else _priced(rate * count)
    if kind != "video" or duration is None or not math.isfinite(duration) or duration <= 0:
        return None
    res = _normalize(resolution)
    if _normalize(provider) == "tokendance":
        return _tokendance(kind=kind, model_id=model_id, n=count, size=size, duration=duration,
                           resolution=resolution, ratio=ratio,
                           has_reference_video=has_reference_video,
                           generate_audio=generate_audio)
    if ark and proto in ("", "seedance"):
        if has_reference_video:
            return None
        aspect = (ratio or "").strip()
        table = _LEGACY_DIMENSIONS if model == "doubao-seedance-1-0-pro-250528" else (
            _MODERN_DIMENSIONS
        )
        if res not in table or aspect not in _RATIOS:
            return None
        width, height = table[res][_RATIOS.index(aspect)]
        rate = p["ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS"].get(model)
        if model == "doubao-seedance-2-0-260128":
            rate = rate["1080p" if res == "1080p" else "standard"]
        elif model == "doubao-seedance-1-5-pro-260428":
            rate = rate["audio" if generate_audio else "silent"]
        if rate is None:
            return None
        return _priced(duration * width * height * 24 / 1024 * rate * count / 1_000_000)
    if host == "dashscope.aliyuncs.com" and proto in ("", "dashscope"):
        for version in ("1-0", "1-1"):
            if model in {f"happyhorse-{version}-{mode}" for mode in ("t2v", "i2v", "r2v")}:
                rate = p[f"HAPPYHORSE_{version.replace('-', '_')}_YUAN_PER_SECOND"].get(res)
                return None if rate is None else _priced(rate * duration * count)
    return None


def _token_tier_fits(plan: dict, prompt_tokens: int) -> bool:
    bounds = plan.get("range")
    if bounds is None:
        return True
    if not isinstance(bounds, dict) or bounds.get("unit") != "kTokens" or not str(
            bounds.get("item", "")).endswith("prompt_tokens"):
        return False
    ktokens = prompt_tokens / 1000
    return (float(bounds.get("lower", 0)) <= ktokens
            and ("upper" not in bounds or ktokens < float(bounds["upper"])))


def _tokendance_text(model_id: str, input_tokens: int, output_tokens: int,
                     cached_tokens: int, cache_write_tokens: int) -> float | None:
    """TokenDance 公开价：元 / 百万 token，按本次 prompt 长度分档（2026-11-18 付费小测逐位对上）。"""
    from character_workflow.lib.tokendance_prices import model_pricing

    items = (model_pricing(model_id) or {}).get("items") or []

    def rate(name: str) -> float | None:
        item = next((entry for entry in items if isinstance(entry, dict)
                     and entry.get("id") == f"openai:chat-completions:{name}"), None)
        rates = {_rate(plan.get("rate")) for plan in (item or {}).get("plans") or []
                 if isinstance(plan, dict) and plan.get("unit") == "millionTokens"
                 and _token_tier_fits(plan, input_tokens)}
        return rates.pop() if len(rates) == 1 and None not in rates else None

    cached = min(max(0, cached_tokens), input_tokens)
    input_rate, output_rate = rate("input_tokens"), rate("completion_tokens")
    cached_rate = rate("cached_tokens") if cached else 0
    if input_rate is None or output_rate is None or cached_rate is None:
        return None
    write_rate = rate("cache_write_tokens") if cache_write_tokens else None
    # Input totals already include cache writes. Using the input rate when no write rate
    # is published underestimates Anthropic cache creation; do not add those tokens twice.
    write_delta = cache_write_tokens * (write_rate - input_rate) if write_rate is not None else 0
    return _priced(((input_tokens - cached) * input_rate + cached * cached_rate + write_delta
                    + output_tokens * output_rate) / 1_000_000)


def estimate_text_cost_cny(
    model_id: str, input_tokens: int, output_tokens: int, *, key: Any = None,
    cached_tokens: int = 0, cache_write_tokens: int = 0, manual: bool = True,
) -> float | None:
    """文本按 token 估价；None 表示未计价。

    传了 key 时按供应商的同步价：Tuzi、TokenDance 已用付费小测核对；OpenAI-HK 用控制台账单核对，
    只认 default 分组。其余渠道只认打包价格表里的精确模型 ID（目前为空）。
    拿不到同步价时，用主机手设的输入 / 输出单价（`ModelSpec.input_cny_per_m` / `output_cny_per_m`，
    元 / 百万 token，两个都填才生效）；同步价优先。网关受理、结算与本机花费显示都经过这里。
    """
    cache_write_tokens = min(max(0, cache_write_tokens), max(0, input_tokens - max(0, cached_tokens)))
    synced = _synced_text_cost(model_id, input_tokens, output_tokens, key=key,
                               cached_tokens=cached_tokens, cache_write_tokens=cache_write_tokens)
    if synced is not None or not manual or key is None:
        return synced
    spec = next((item for item in getattr(key, "models", None) or [] if item.id == model_id), None)
    rate_in = getattr(spec, "input_cny_per_m", None)
    rate_out = getattr(spec, "output_cny_per_m", None)
    if rate_in is None or rate_out is None:
        return None
    return _priced((input_tokens * rate_in + output_tokens * rate_out) / 1_000_000)


def _synced_text_cost(model_id: str, input_tokens: int, output_tokens: int, *, key: Any,
                      cached_tokens: int, cache_write_tokens: int) -> float | None:
    if key is not None:
        host = _hostname(key.base_url)
        if _domain(host, "tu-zi.com"):
            from character_workflow.lib.tuzi_estimate import text_cost_cny

            return text_cost_cny(billing_group=key.billing_group, model_id=model_id,
                                 input_tokens=input_tokens, output_tokens=output_tokens,
                                 cached_tokens=cached_tokens)
        if key.provider == "tokendance":
            return _tokendance_text(model_id, input_tokens, output_tokens, cached_tokens, cache_write_tokens)
        if _domain(host, "openai-hk.com"):
            from character_workflow.lib.openai_hk_prices import text_cost_cny as hk_text_cost

            return hk_text_cost(model_id=model_id, input_tokens=input_tokens,
                                output_tokens=output_tokens, billing_group=key.billing_group)
    rate = _PRICES["text_yuan_per_million_tokens"].get(model_id)
    if rate is None:
        return None
    write_rate = rate.get("cache_write", rate["input"])
    return _priced(((input_tokens - cache_write_tokens) * rate["input"] + cache_write_tokens * write_rate
                    + output_tokens * rate["output"]) / 1_000_000)


AUDIO_UNIT_CHARACTERS = 1000


def with_manual_price(estimate: float | None, model) -> float | None:
    """没有同步价时用主机手设的每次调用价格（`ModelSpec.per_call_cny`，元 / 次）；同步价优先。"""
    if estimate is not None or model is None:
        return estimate
    return getattr(model, "per_call_cny", None)


def audio_unit_cost_cny(key, model, *, manual: bool = True) -> float | None:
    """模型菜单与「最便宜」排序用的音频单价：语音每千字、音乐每首。"""
    from character_workflow.lib.audio_caps import audio_caps

    caps = audio_caps(key, model)
    if caps is None:
        return with_manual_price(None, model) if manual else None
    common = {"kind": "audio", "provider": key.provider, "base_url": key.base_url,
              "model_id": model.id, "protocol": model.protocol}
    if caps.family == "music":
        synced = estimate_cost_cny(**common, n=1)
    else:
        synced = estimate_cost_cny(**common, text_length=AUDIO_UNIT_CHARACTERS)
    return with_manual_price(synced, model) if manual else synced


# 判断「有没有同步价」用的代表性参数：图片按默认尺寸，视频按 5 秒 720p 16:9。
_PROBE_PARAMS = {"image": {}, "video": {"duration": 5, "resolution": "720p", "ratio": "16:9"}}
# 文本按 1000 / 1000 token 估一次。
_TEXT_PROBE_TOKENS = 1000


def _probe_variants(key, model, modality: str) -> list[dict]:
    """代表性参数 + 逐维变体（每次只变一维）。只取会让定价分支返回无价、且该模型声明支持的功能开关：
    视频带参考视频 / 生成音频，图片带参考图 / 图片编辑 / 图层拆分。分辨率、时长后端没有统一能力表，不枚举。"""
    base = dict(_PROBE_PARAMS[modality])
    variants = [base]
    if modality == "video":
        variants.append({**base, "generate_audio": True})
        if _accepts_reference_video(key, model):
            variants.append({**base, "reference_videos": ["probe.mp4"]})
        return variants
    variants.append({**base, "reference_images": ["probe.png"]})
    variants.append({**base, "image_edit": {"mode": "inpaint"}, "reference_images": ["probe.png"]})
    from character_workflow.lib.callers.openai_image import supports_layer_decomposition

    if supports_layer_decomposition(key, model.id):
        variants.append({**base, "layer_decomposition": True, "reference_images": ["probe.png"]})
    return variants


def _accepts_reference_video(key, model) -> bool:
    from character_workflow.lib.callers import _effective_protocol
    from character_workflow.lib.video_caps import kling_spec, seedance_limits

    protocol = _effective_protocol(key, model.id)
    if protocol == "seedance":
        return seedance_limits(model.id).max_videos > 0
    if protocol in ("klingai", "evolink"):
        spec = kling_spec(model.id)
        return bool(spec and spec.max_videos > 0)
    return False


def has_no_synced_price(key, model) -> bool | None:
    """供应商页「单价」框的显示判据：至少有一种参数组合拿不到同步价，就是未定价（第 5 批 5-5）。

    图片 / 视频按代表性参数 + 逐维变体探测（`_probe_variants`），例如 Ark 视频带参考视频时不估价；
    文本按 1000 / 1000 token 估一次；局域网 Atelier 供应商（价格在主机那边）返回 None，不给这个标记。
    """
    from character_workflow.lib.keys import model_modality

    modality = model_modality(model, key)
    if key.provider == "atelier" or modality not in ("image", "video", "audio", "text"):
        return None
    if modality == "audio":
        return audio_unit_cost_cny(key, model, manual=False) is None
    if modality == "text":
        return estimate_text_cost_cny(model.id, _TEXT_PROBE_TOKENS, _TEXT_PROBE_TOKENS, key=key,
                                      manual=False) is None
    return any(estimate_submission(key, model.id, modality, params, manual=False) is None
               for params in _probe_variants(key, model, modality))


def estimate_submission(key, model_id: str, kind: str, params: dict, *,
                        manual: bool = True) -> float | None:
    """Use the same frozen size intent as submission, without creating a job.

    音频没有文本就没有总价，这里返回单价（见 audio_unit_cost_cny）。
    """
    from character_workflow.lib.image_size import normalize_image_size_params
    from character_workflow.lib.keys import size_channel

    model = next((item for item in key.models if item.id == model_id), None)
    if model is None:
        return None
    if kind == "audio":
        return audio_unit_cost_cny(key, model, manual=manual)
    priced_model = model
    key, model = size_channel(key, model)
    model_id = model.id
    try:
        values = normalize_image_size_params(key, model_id, params) if kind == "image" else params
    except ValueError:
        return None
    synced = estimate_cost_cny(
        kind=kind, provider=key.provider, base_url=key.base_url, billing_group=key.billing_group,
        model_id=model_id, protocol=model.protocol, n=values.get("n") or 1,
        size=values.get("size"), size_mode=values.get("size_mode"), quality=values.get("quality"),
        resolution=values.get("resolution"), duration=values.get("duration"), ratio=values.get("ratio"),
        generate_audio=bool(values.get("generate_audio")),
        has_reference_video=bool(values.get("reference_videos")),
        image_edit=bool(values.get("image_edit")),
        reference_image_count=max(len(values.get("reference_images") or []),
                                  1 if values.get("image_edit") else 0),
        layer_decomposition=bool(values.get("layer_decomposition")),
    )
    return with_manual_price(synced, priced_model) if manual else synced
