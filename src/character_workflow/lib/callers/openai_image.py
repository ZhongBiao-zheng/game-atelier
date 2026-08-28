"""OpenAI-compatible image generation caller for openai/seedream/custom providers."""
from __future__ import annotations

import base64
from collections.abc import Mapping
from http.client import IncompleteRead
import io
import math
import re
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests
from PIL import Image, ImageOps, UnidentifiedImageError

from character_workflow.lib import net_env
from character_workflow.lib.callers import tuzi_async

DEFAULT_SEEDREAM_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_TOKENDANCE_BASE_URL = "https://tokendance.space/gateway/v1"
_KNOWN_ENDPOINT_SUFFIXES = (
    "/images/generations",
    "/images/edits",
    "/chat/completions",
    "/completions",
    "/embeddings",
    "/moderations",
)
# 网关瞬时错误：聚合商（OpenAI-HK 的 new-api 等）上游慢/排队时合成 502/503/504 回吐，
# 重试一次往往就过。仅这三个码进重试；其余 4xx 及 429/500 是确定性/限流错误，当场致命。
_RETRYABLE_STATUS = frozenset({502, 503, 504})
# 落在瞬时码里但确定性的错误：网关明说「该模型下无可用端点」（模型未开通 / 不支持当前协议），
# 重试多少次都是同一个答案，白等三轮退避。命中即当场致命。
_FATAL_BODY_MARKERS = ("no_endpoints_available", "无可用端点")


class OpenAIImageError(RuntimeError):
    pass


def _warn(kwargs: dict, message: str) -> None:
    """把「后端改写了什么」写回 job.params.warnings —— 这些改写此前一律是静默的。

    params dict 由 job_runner 传入、并在 dispatch 返回后整体落盘（run_job → _save_params），
    所以就地 append 即可。Skill 直调 render（没有 params）时静默跳过。
    """
    params = kwargs.get("params")
    if not isinstance(params, dict):
        return
    warnings = params.get("warnings")
    if not isinstance(warnings, list):
        warnings = []
        params["warnings"] = warnings
    if message not in warnings:  # 补足循环会重复调用，去重
        warnings.append(message)


# 不支持 Ark 组图参数的模型：实测 seedream-5.0-pro 收到 sequential_image_generation 直接 400。
# 这是**模型**属性，与 provider 无关 —— 火山直连、Tuzi、词元跳动上的同一模型都拒。
_NO_SEQUENTIAL_MODELS = ("seedream-5-0-pro",)


def _supports_sequential(model: str) -> bool:
    m = normalized_model_id(model)
    return not any(bad in m for bad in _NO_SEQUENTIAL_MODELS)


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    n: int = 1,
    timeout: float | tuple[float, float] = net_env.DEFAULT_TIMEOUT,
    **kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys as _keys

    key = _keys.find_by_alias(alias)
    if key is None:
        raise ValueError(f"alias not found: {alias}")
    if key.provider not in ("openai", "seedream", "tokendance", "custom"):
        raise ValueError(
            f"alias {alias!r} has provider {key.provider!r}, "
            "expected openai/seedream/tokendance/custom"
        )

    base_url = (key.base_url or "").strip()
    if not base_url:
        if key.provider == "openai":
            base_url = DEFAULT_OPENAI_BASE_URL
        elif key.provider == "seedream":
            base_url = DEFAULT_SEEDREAM_BASE_URL
        elif key.provider == "tokendance":
            base_url = DEFAULT_TOKENDANCE_BASE_URL
    if not base_url:
        raise OpenAIImageError("custom provider requires base_url")

    family = image_family(model)
    mask_path = kwargs.get("mask_image") or (kwargs.get("params") or {}).get("mask_image")
    if mask_path and not supports_image_mask(
        key.provider,
        model,
        _effective_image_protocol(key, model),
    ):
        raise OpenAIImageError("current image model does not support mask edits")
    # 尺寸下限是模型属性，与 provider / 网关无关（实测：同一把词元跳动 key 下 5.0-lite 要
    # 3686400 像素、5.0-pro 只要 921600，两条协议路径给出的下限一模一样）。所以归一化按
    # 模型族判，火山直连 / Tuzi / 词元跳动下的 seedream 一视同仁。
    is_seedream = family == "seedream"
    # 组图（sequential）仍按老判据：只对直连火山和 custom 聚合商下的 seedream 发。
    # 注意它与下面的 watermark / output_format 不同步 —— 那两个是**出图外观**，必须按模型族
    # 覆盖所有 seedream 路径（含词元跳动），见 _image_generation_payload 里的实测注释。
    sends_ark_params = key.provider == "seedream" or (key.provider == "custom" and is_seedream)
    raw_size = (
        kwargs.get("size") or kwargs.get("requested_size") or kwargs.get("params", {}).get("size")
    )
    requested_size = _normalize_size_for_provider(raw_size, is_seedream, model)
    if requested_size != raw_size:
        grew = _size_pixels(requested_size) > _size_pixels(raw_size)
        edge = "放大到该模型的像素下限" if grew else "缩小到该模型的像素上限"
        _warn(kwargs, f"尺寸已{edge}：{raw_size} → {requested_size}")

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    is_hk = _is_openai_hk(base_url)
    is_tuzi = _is_tuzi_gateway(base_url)
    requested = max(1, int(n or 1))
    params = kwargs.get("params") if isinstance(kwargs.get("params"), dict) else None
    stored_task_ids = (
        list(params.get("provider_task_ids") or [])
        if params and params.get("provider_task_protocol") == "tuzi_async"
        else []
    )
    resuming_stored_tasks = bool(stored_task_ids)
    task_cursor = 0

    def _next_task_id() -> str | None:
        nonlocal task_cursor
        value = stored_task_ids[task_cursor] if task_cursor < len(stored_task_ids) else None
        task_cursor += 1
        return value

    def _remember_task_id(task_id: str) -> None:
        if task_id not in stored_task_ids:
            stored_task_ids.append(task_id)
        if params is not None:
            params["provider_task_protocol"] = "tuzi_async"
            params["provider_task_ids"] = list(stored_task_ids)
        callback = kwargs.get("on_task_id")
        if callable(callback):
            callback(task_id)

    def _post_image_json(url: str, payload: dict) -> dict:
        if not is_tuzi:
            return _post_json(url, key.access_key, payload, timeout=timeout)
        return tuzi_async.execute_json(
            url=url,
            api_key=key.access_key,
            payload=payload,
            task_id=_next_task_id(),
            on_task_id=_remember_task_id,
            on_phase=kwargs.get("on_phase"),
            should_cancel=kwargs.get("should_cancel"),
        )

    # HK gpt-image 只认尺寸表的精确 WxH；表外值（如立绘常用的 1024x1536）会被出成正方形。
    # snap 到表内最近值，让 skill 立绘 / Studio 两条路径都拿到正确竖图。nano-banana 收比例串，不碰。
    if is_hk and family == "gpt-image":
        snapped = _snap_hk_gpt_image_size(requested_size)
        if snapped != requested_size:
            _warn(kwargs, f"尺寸已吸附到 OpenAI-HK 支持的档位：{requested_size} → {snapped}")
        requested_size = snapped

    # OpenAI-HK 的非图像模型回退 chat 模式（从 markdown/url 提取图）。
    # gpt-image / nano-banana 走真正的 images 端点，size 与 quality 才会生效。
    if is_hk and not _hk_image_model(model):
        image_paths: list[str] = []
        source_image = kwargs.get("source_image") or (kwargs.get("params") or {}).get("source_image")
        if source_image:
            image_paths.append(str(source_image))
        for ref in (kwargs.get("reference_images") or (kwargs.get("params") or {}).get("reference_images") or []):
            if str(ref) not in image_paths:
                image_paths.append(str(ref))
        image_paths = image_paths[: _max_reference_images(key.provider, model)]

        paths: list[str] = []
        for _ in range(requested):
            data = _post_json(
                _chat_image_url(base_url),
                key.access_key,
                _chat_image_payload(
                    prompt=prompt,
                    model=model,
                    size=requested_size,
                    image_paths=image_paths or None,
                ),
                timeout=timeout,
            )
            paths.extend(_write_outputs(data, out_dir, start_index=len(paths) + 1))
            if len(paths) >= requested:
                break
        return paths[:requested]

    # custom 走 family 判定补诚实；命名 provider(openai/seedream/tokendance/HK) 分支不动。
    # family / is_seedream 已在上方（尺寸归一化前）算好，这里不重算。
    # quality 按**族**判，与前端 imageControlCaps 同一判据（旧版按 provider：词元跳动上的
    # gpt-image 界面给四档、后端静默丢弃；provider=openai 下的 dall-e 反过来会被塞进
    # gpt-image 的 low/high 词表，而 DALL·E 只认 standard|hd）。
    wants_quality = family in ("gpt-image", "nano-banana")
    quality = _quality_param(kwargs) if wants_quality else None
    image_protocol = _effective_image_protocol(key, model)
    background = (
        _background_param(kwargs)
        if family == "gpt-image" and image_protocol in {None, "openai"}
        else None
    )
    ref_paths = _collect_ref_paths(kwargs, key.provider, model)
    if mask_path and not ref_paths:
        raise OpenAIImageError("mask edit requires a source image")

    # 图生图端点按族分流：gpt-image 族走官方同步 /images/edits（multipart，OpenAI/HK 实现）。
    # nano-banana 是 Gemini 多模态，OpenAI-HK / 聚合商对其 /images/edits 一律 403（openresty
    # 网关层拒未实现路由），必须走 generations 的 image 字段（实测 OpenAI-HK 可用）——
    # 故 edits 仅限 gpt-image，nano-banana 落到下方 generations+image 兜底。
    # 不用 generations+image 做 gpt-image（那是 Ark/seedream 路子），更绝不加 ?async=true。
    supports_edits = supports_image_mask(
        key.provider,
        model,
        _effective_image_protocol(key, model),
    )
    if supports_edits and ref_paths:
        paths: list[str] = []
        for _ in range(requested):
            if is_tuzi and resuming_stored_tasks and task_cursor >= len(stored_task_ids):
                _warn(kwargs, f"恢复的厂商任务只返回了 {len(paths)} 张图（请求 {requested} 张）")
                break
            fields = _hk_edits_fields(
                model=model, prompt=prompt, size=requested_size, quality=quality,
                background=background, n=1,
            )
            files = _ref_file_parts(ref_paths, str(mask_path) if mask_path else None)
            data = (
                tuzi_async.execute_multipart(
                    url=_edits_url(base_url), api_key=key.access_key,
                    fields=fields, files=files, task_id=_next_task_id(),
                    on_task_id=_remember_task_id, on_phase=kwargs.get("on_phase"),
                    should_cancel=kwargs.get("should_cancel"),
                )
                if is_tuzi else
                _post_multipart(
                    _edits_url(base_url), key.access_key, fields=fields, files=files,
                    timeout=timeout,
                )
            )
            paths.extend(_write_outputs(data, out_dir, start_index=len(paths) + 1))
            if len(paths) >= requested:
                break
        return paths[:requested]

    ref_image = _reference_image_param(kwargs, key.provider, model)

    # 网关按协议挂端点：同一网关下不同模型支持的协议不同，打错入口会被判「无可用端点」。
    # 只有 ark 需要换 URL；None / openai 走默认 OpenAI 兼容入口，其他显式协议必须拒绝，
    # 不能把用户手动错标的 chat/audio 模型伪兼容成图片模型。
    if image_protocol not in {None, "openai", "ark"}:
        raise OpenAIImageError(
            f"image protocol {image_protocol!r} is not supported; expected openai or ark"
        )
    is_ark_image = image_protocol == "ark"
    generations_url = _ark_image_url(base_url) if is_ark_image else _image_url(base_url)

    def _gen_payload(num: int) -> dict:
        return _image_generation_payload(
            model=model,
            prompt=prompt,
            size=requested_size,
            n=num,
            image=ref_image,
            quality=quality,
            background=background,
            seedream=is_seedream,
            sequential=sends_ark_params and _supports_sequential(model),
        )

    data = _post_image_json(generations_url, _gen_payload(requested))
    paths = _write_outputs(data, out_dir)
    # 补足循环无条件开：终止条件本来就是「已拿到几张」，一次回够就不会进来。旧版按
    # provider/族开关，standard 族聚合商（Tuzi 等）忽略 n 只回 1 张时会静默少图。
    while len(paths) < requested:
        if is_tuzi and resuming_stored_tasks and task_cursor >= len(stored_task_ids):
            _warn(kwargs, f"恢复的厂商任务只返回了 {len(paths)} 张图（请求 {requested} 张）")
            break
        data = _post_image_json(generations_url, _gen_payload(1))
        before = len(paths)
        paths.extend(_write_outputs(data, out_dir, start_index=before + 1))
        if len(paths) == before:  # 一张都没多出来：厂商给不了更多，别空转
            _warn(kwargs, f"厂商只返回了 {len(paths)} 张图（请求 {requested} 张）")
            break
    return paths[:requested]


def resolve_image_protocol(provider: str, base_url: str | None, model: str) -> str | None:
    """图片调用协议启发式 —— 返回 "ark" / "openai" / None（None = 走默认 OpenAI 兼容入口）。

    权威来源是网关 `GET /models` 的 `supported_protocols`（models-preview 解析后存进
    ModelSpec.protocol）；这里只兜底两种情况：旧 key 没存过 protocol、用户手填了不在
    models[] 里的模型 id。

    词元跳动的 seedream 系原生挂在 Ark 协议下，其中 seedream-5.0-pro **只有**
    `ark:image-generations`——打 OpenAI 兼容入口会被网关判 503「模型下无可用端点」。

    判据同时看 provider 名与 base_url 的 host：把词元跳动配成 provider=custom（UI 完全
    允许）时，只看 provider 名会漏判，又回到那个 503。
    """
    if (provider == "tokendance" or _is_tokendance_gateway(base_url)) and (
        image_family(model) == "seedream"
    ):
        return "ark"
    return None


def _is_tokendance_gateway(base_url: str | None) -> bool:
    """按 host 判词元跳动网关 —— 比 `"tokendance" in base` 精确（路径里出现不算）。"""
    return "tokendance" in urlsplit((base_url or "").strip()).netloc.lower()


def _effective_image_protocol(key, model: str) -> str | None:
    """模型已存 protocol 优先（models-preview 从上游协议表解析），未注册模型回退启发式。

    形状对齐视频侧 callers._effective_protocol。视频协议值（seedance/kling/…）落到
    图片路径也不会误伤：调用方只认 "ark"。
    """
    spec = next((m for m in key.models if m.id == model), None)
    if spec and spec.protocol:
        return spec.protocol
    return resolve_image_protocol(key.provider, key.base_url, model)


def _image_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/images/generations"


def _ark_image_url(base_url: str) -> str:
    """Ark 原生协议的图片端点。

    词元跳动网关把 Ark 挂在 {gateway}/ark/v3（key 里存的 base 是 OpenAI 兼容入口
    …/gateway/v1，需剥掉 /v1），与 volcengine_video._tasks_url 同构；火山直连的 base
    本身就是 Ark 根，端点与 OpenAI 兼容路径同形。
    """
    base = base_url.rstrip("/")
    if _is_tokendance_gateway(base):
        root = base[: -len("/v1")] if base.endswith("/v1") else base
        return f"{root}/ark/v3/images/generations"
    return _image_url(base_url)


def _edits_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/images/edits"


def _guess_mime(path: str) -> str:
    ext = Path(path).suffix.lstrip(".").lower() or "png"
    return "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"


def _ref_file_parts(paths: list[str], mask_path: str | None = None) -> list[tuple]:
    """multipart 文件部件列表；多张参考图重复 `image` 字段名（OpenAI-HK edits 约定）。"""
    parts: list[tuple] = []
    source_size: tuple[int, int] | None = None
    for p in paths:
        if mask_path:
            image_bytes, size = _normalized_edit_image(Path(p))
            source_size = source_size or size
            parts.append(("image", (f"{Path(p).stem}.png", image_bytes, "image/png")))
        else:
            parts.append(("image", (Path(p).name, Path(p).read_bytes(), _guess_mime(p))))
    if mask_path:
        if source_size is None:
            raise OpenAIImageError("mask edit requires a source image")
        parts.append(("mask", ("mask.png", _normalized_edit_mask(Path(mask_path), source_size), "image/png")))
    return parts


def _normalized_edit_image(path: Path) -> tuple[bytes, tuple[int, int]]:
    try:
        with Image.open(path) as opened:
            if getattr(opened, "is_animated", False) or getattr(opened, "n_frames", 1) != 1:
                raise OpenAIImageError("mask edit source must be a static image")
            opened.load()
            oriented = ImageOps.exif_transpose(opened)
            has_alpha = "A" in oriented.getbands() or "transparency" in opened.info
            normalized = oriented.convert("RGBA" if has_alpha else "RGB")
            output = io.BytesIO()
            normalized.save(output, format="PNG")
            return output.getvalue(), normalized.size
    except OpenAIImageError:
        raise
    except (OSError, UnidentifiedImageError, ValueError) as error:
        raise OpenAIImageError("mask edit source is not a readable image") from error


def _normalized_edit_mask(path: Path, source_size: tuple[int, int]) -> bytes:
    try:
        with Image.open(path) as opened:
            if opened.format != "PNG" or opened.size != source_size:
                raise OpenAIImageError("mask and source image must have identical PNG dimensions")
            opened.load()
            gray = opened.convert("L")
            rgba = Image.new("RGBA", source_size, (255, 255, 255, 255))
            rgba.putalpha(gray)
            output = io.BytesIO()
            rgba.save(output, format="PNG")
            return output.getvalue()
    except OpenAIImageError:
        raise
    except (OSError, UnidentifiedImageError, ValueError) as error:
        raise OpenAIImageError("mask is not a readable PNG image") from error


def _hk_edits_fields(
    *, model: str, prompt: str, size: object, quality: str | None,
    background: str | None = None, n: int = 1,
) -> dict:
    fields: dict[str, str] = {"model": model, "prompt": prompt, "n": str(max(1, n))}
    if size:
        fields["size"] = str(size)
    if quality:
        fields["quality"] = quality
    if background:
        fields["background"] = background
    return fields


def _post_multipart(
    url: str, api_key: str, *, fields: dict, files: list, timeout: float | tuple[float, float]
) -> dict:
    # 不手动设 Content-Type，让 requests 生成 multipart boundary。
    # files 字节已在 _ref_file_parts 预读入内存，重试重发同一份 data/files 安全。
    headers = {"Authorization": f"Bearer {api_key}"}
    for attempt in range(3):
        resp = requests.post(url, headers=headers, data=fields, files=files, timeout=timeout)
        if resp.status_code >= 400:
            err = OpenAIImageError(f"image edits api {resp.status_code}: {resp.text[:500]}")
            if _is_retryable(resp.status_code, resp.text) and attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise err
        return resp.json()
    # 循环只会经 return/raise 退出（末轮瞬时码也走 raise）；防御性兜底。
    raise OpenAIImageError("image edits api: retries exhausted")


def _is_retryable(status_code: int, body: str) -> bool:
    """瞬时码里剔掉确定性错误：网关明说「无可用端点」时重试三轮也只是同一个答案。"""
    if status_code not in _RETRYABLE_STATUS:
        return False
    low = (body or "").lower()
    return not any(marker in low for marker in _FATAL_BODY_MARKERS)


def _chat_image_url(base_url: str) -> str:
    return f"{_api_root(base_url)}/chat/completions"


def _image_generation_payload(
    *,
    model: str,
    prompt: str,
    size: object,
    n: int,
    image: str | list[str] | None = None,
    quality: str | None = None,
    background: str | None = None,
    seedream: bool = False,
    sequential: bool = False,
) -> dict:
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
        "response_format": "b64_json",
        "stream": False,
    }
    if seedream:  # Ark 专有的两个出图外观参数，**省略都不是安全默认**
        # watermark：Ark 默认 true。实测反证 —— 词元跳动那条路我们从来没发过这个参数，
        # 出来的图右下角照样有「AI 生成」；火山直连/Tuzi 那条路旧版还主动发 true。两条路
        # 的历史产物一张不落全带水印。要不带水印只能显式 false。
        payload["watermark"] = False
        # output_format：Ark 默认 jpeg，而我们把产物一律存成 .png —— 实测 26 张历史产物里
        # 11 张实际是 JPEG，既名实不符又白挨一道有损压缩。立绘要无损，显式要 png。
        payload["output_format"] = "png"
    if quality:  # gpt-image / nano-banana：low/medium/high/auto
        payload["quality"] = quality
    if background:  # gpt-image：auto/opaque/transparent
        payload["background"] = background
    # Seedream / Ark 图生图：image 接受 URL 或 base64 data-url，单张为 str、多张为 list。
    if image:
        payload["image"] = image
    if sequential and n > 1:  # seedream 组图
        payload["sequential_image_generation"] = "auto"
        payload["sequential_image_generation_options"] = {"max_images": n}
    return {k: v for k, v in payload.items() if v is not None}


def normalized_model_id(model: str) -> str:
    """能力判定前的 id 归一 —— 与前端 `web/src/lib/modelFamily.ts` 逐字对齐。

    取最后一个 '/' 之后的尾段（聚合商的 `openai/gpt-image-2` 这类 slug）→ lower()
    → '_' 与 '.' 都归一为 '-'（`nano_banana_pro` / `seedream-5.0-pro` 两种写法都要命中）。
    """
    return (model or "").rsplit("/", 1)[-1].lower().replace("_", "-").replace(".", "-")


def image_family(model: str) -> str:
    """模型族判定 —— 能力矩阵的唯一判据（参考图上限 / quality / 尺寸下限都按它走）。

    规则与前端共用，由 tests/fixtures/capability-matrix.json 锁死。
    provider 不参与族判定：同一个模型走直连还是走聚合商，能力是一样的。
    """
    m = normalized_model_id(model)
    # MJ 走任务代理协议（异步 submit + 轮询），控件形态与其余族完全不同：无尺寸、无质量，
    # 比例/版本/stylize 由渠道锁定。模型 id 形如 mj_fast_imagine / mj_relax_upscale。
    if m.startswith("mj-") or "midjourney" in m or m.startswith("niji"):
        return "midjourney"
    if "gpt-image" in m:
        return "gpt-image"
    if "nano-banana" in m:
        return "nano-banana"
    if "seedream" in m or "seededit" in m:
        return "seedream"
    return "standard"


def supports_image_mask(provider: str, model: str, protocol: str | None = None) -> bool:
    """Whether this configured transport has a verified GPT Image edits endpoint."""
    return (
        image_family(model) == "gpt-image"
        and provider in {"openai", "custom"}
        and protocol in {None, "openai"}
    )


def _hk_image_model(model: str) -> bool:
    """OpenAI-HK 上走 images 端点（支持 size+quality）的模型族。

    走 image_family 而非裸 startswith：大小写、下划线、斜杠 slug 都归一后再判，
    否则 `GPT-Image-2` 会掉进下面的 chat/completions 兜底路径。
    """
    return image_family(model) in ("gpt-image", "nano-banana")


def _quality_param(kwargs: dict) -> str | None:
    params = kwargs.get("params") or {}
    q = kwargs.get("quality") or params.get("quality")
    return q if q in ("low", "medium", "high", "auto") else None


def _background_param(kwargs: dict) -> str | None:
    params = kwargs.get("params") or {}
    background = kwargs.get("background") or params.get("background")
    return background if background in ("auto", "opaque", "transparent") else None


def max_reference_images(model: str) -> int:
    """Return the image-reference limit shared by submission and provider callers."""
    family = image_family(model)
    if family == "seedream":
        return 10
    if family == "gpt-image":
        return 16
    if family == "nano-banana":
        return 3
    return 4


def _max_reference_images(provider: str, model: str) -> int:
    """参考图（图生图输入）数量上限 —— 按**模型族**判，不按 provider。

    - seedream：10（旧代码只认 provider=="seedream"，Tuzi / 词元跳动下的同一模型被砍到 4）
    - gpt-image：16   - nano-banana：3（官方建议 ≤2，放宽到 3）   - 其余：保守 4

    provider 参数保留只为签名兼容调用点；判据已完全交给 image_family。
    与前端 `web/src/lib/referenceLimits.ts` 同表，由 capability-matrix.json 锁死。
    """
    return max_reference_images(model)


def _collect_ref_paths(kwargs: dict, provider: str, model: str) -> list[str]:
    """source_image + reference_images → 去重 + 按厂商/模型上限截断的本地路径列表。"""
    params = kwargs.get("params") or {}
    paths: list[str] = []
    source_image = kwargs.get("source_image") or params.get("source_image")
    if source_image:
        paths.append(str(source_image))
    for ref in (kwargs.get("reference_images") or params.get("reference_images") or []):
        if str(ref) not in paths:
            paths.append(str(ref))
    limit = _max_reference_images(provider, model)
    if len(paths) > limit:
        _warn(kwargs, f"参考图超过该模型上限，只发送了前 {limit} 张（共 {len(paths)} 张）")
    return paths[:limit]


def _reference_image_param(
    kwargs: dict, provider: str, model: str
) -> str | list[str] | None:
    """参考图 → base64 data-url(s)，用于 generations 的 `image` 字段（Ark/seedream 图生图）。

    单张返回 str、多张返回 list、无返回 None。
    """
    urls = [_image_data_url(p) for p in _collect_ref_paths(kwargs, provider, model)]
    if not urls:
        return None
    return urls[0] if len(urls) == 1 else urls


def _image_data_url(path: str) -> str:
    raw = Path(path).read_bytes()
    b64 = base64.b64encode(raw).decode()
    ext = Path(path).suffix.lstrip(".").lower() or "png"
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    return f"data:{mime};base64,{b64}"


def _api_root(base_url: str) -> str:
    base = base_url.rstrip("/")
    for suffix in _KNOWN_ENDPOINT_SUFFIXES:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    parts = urlsplit(base)
    path = parts.path.rstrip("/")
    if not path or path == "/":
        path = "/v1"
    base = urlunsplit((parts.scheme, parts.netloc, path, "", ""))
    return base.rstrip("/")


def _post_json(url: str, api_key: str, payload: dict, *, timeout: float | tuple[float, float]) -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    for attempt in range(3):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
            if resp.status_code >= 400:
                err = OpenAIImageError(f"image api {resp.status_code}: {resp.text[:500]}")
                # 瞬时网关错误复用网络异常那套退避重试（continue 进下一轮）；其余当场抛。
                if _is_retryable(resp.status_code, resp.text) and attempt < 2:
                    time.sleep(1 + attempt)
                    continue
                raise err
            return resp.json()
        except OpenAIImageError:
            raise
        except ValueError as e:
            # 拿到了 200 但响应体不是 JSON：这次调用**已经在上游执行过**（多半也计过费），
            # 重试只会再跑一次完整生成。当场致命，把原文交给上层翻译。
            raise OpenAIImageError(f"image api 响应非 JSON: {e}") from e
        except requests.RequestException as e:
            if not _is_pre_flight_failure(e) or attempt >= 2:
                raise OpenAIImageError(str(e)) from e
            time.sleep(1 + attempt)
    # 循环只经 return / raise 退出（末轮走上面的 raise）；防御性兜底。
    raise OpenAIImageError("image api: retries exhausted")


def _is_pre_flight_failure(error: BaseException) -> bool:
    """请求是否**没能送达上游** —— 只有这类失败重试才不会重复计费。

    同步出图端点在图出完之前一个字节都不吐，所以「读超时」几乎必然意味着上游正在真跑：
    重试等于再买一次。实测记录（memory: image-upload-timeout-and-gateway-drop）：读超时
    180s 时 HK 复杂生成假超时 → 重试 → 墙钟 180s 翻到 350s + 厂商双计费。同理，连接建立
    之后被掐（RemoteDisconnected / reset）也说明请求已经发出去了。

    只有连接**建立阶段**的失败（连接超时、DNS、拒绝连接）能安全重试。
    """
    if isinstance(error, requests.ConnectTimeout):  # 必须排在 ConnectionError 之前
        return True
    if isinstance(error, requests.ReadTimeout):
        return False
    if isinstance(error, requests.ConnectionError):
        # ConnectionError 同时涵盖「连不上」与「连上后被掐」，只能按报文区分。
        dropped = (
            "remote end closed", "remotedisconnected", "connection reset",
            "reset by peer", "connection aborted", "broken pipe",
        )
        return not any(marker in str(error).lower() for marker in dropped)
    return False


def _write_outputs(payload: dict, output_dir: Path, *, start_index: int = 1) -> list[str]:
    if "choices" in payload:
        payload = _chat_payload_to_image_payload(payload)
    items = payload.get("data")
    if not isinstance(items, list) or not items:
        raise OpenAIImageError(f"image api response missing data: {payload!r}")

    paths: list[str] = []
    for i, item in enumerate(items, start=start_index):
        if not isinstance(item, dict):
            continue
        target = output_dir / f"v{i}.png"
        b64 = item.get("b64_json")
        # 空串防御：Tuzi 在 response_format=url 时仍回 b64_json:""，别把空串当图写出空文件——
        # 落到下面的 url 分支。
        if isinstance(b64, str) and b64:
            target.write_bytes(_decode_b64_image(b64))
            paths.append(str(target))
            continue
        if isinstance(item.get("url"), str):
            target.write_bytes(_download_image_url(_clean_image_url(item["url"])))
            paths.append(str(target))
    if not paths:
        raise OpenAIImageError(f"image api returned no downloadable image: {payload!r}")
    return paths


def _decode_b64_image(value: str) -> bytes:
    if "," in value and value.lstrip().startswith("data:"):
        value = value.split(",", 1)[1]
    return base64.b64decode(value)


def _is_openai_hk(base_url: str) -> bool:
    return "openai-hk.com" in urlsplit(base_url).netloc.lower()


def _is_tuzi_gateway(base_url: str) -> bool:
    host = (urlsplit(base_url).hostname or "").lower()
    return host == "tu-zi.com" or host.endswith(".tu-zi.com")


# HK gpt-image 只接受尺寸表里的精确 WxH；表外值（如 1024x1536）会被按总像素出成
# 正方形（1024×1536=1,572,864 → 1254²）。表来自 openai-hk.com/docs/openai/gpt-image。
# 注意：这是 HK 专有表，真 OpenAI 的 gpt-image 枚举不同，不要套用；nano-banana 收的是
# 比例串（9x16），也不走这里。
_HK_GPT_IMAGE_SIZES: tuple[tuple[int, int], ...] = (
    (1024, 1024), (2048, 2048), (2880, 2880),  # 1:1
    (1280, 720), (2048, 1152), (3840, 2160),  # 16:9
    (720, 1280), (1152, 2048), (2160, 3840),  # 9:16
    (1040, 832), (2080, 1664), (3200, 2560),  # 5:4
    (832, 1040), (1664, 2080), (2560, 3200),  # 4:5
    (1024, 768), (2048, 1536), (3264, 2448),  # 4:3
    (768, 1024), (1536, 2048), (2448, 3264),  # 3:4
    (1008, 672), (2064, 1376), (3504, 2336),  # 3:2
    (672, 1008), (1376, 2064), (2336, 3504),  # 2:3
    (1344, 576), (2016, 864), (3808, 1632),  # 21:9
)


def _snap_hk_gpt_image_size(size: object) -> object:
    """把任意 WxH 吸附到 HK gpt-image 支持的精确尺寸：先比例最近、再像素最近。

    HK gpt-image 表外值会被出成正方形，故必须 snap。`auto` 与非 WxH 串原样返回；
    已在表内的精确值不动。
    """
    if not isinstance(size, str):
        return size
    s = size.strip()
    if s.lower() == "auto" or not re.fullmatch(r"\d+x\d+", s):
        return size
    rw, rh = (int(v) for v in s.split("x"))
    if rw <= 0 or rh <= 0:
        return size
    if (rw, rh) in _HK_GPT_IMAGE_SIZES:
        return s
    req_logratio = math.log(rw / rh)
    req_logpx = math.log(rw * rh)
    best = min(
        _HK_GPT_IMAGE_SIZES,
        key=lambda wh: (
            round(abs(math.log(wh[0] / wh[1]) - req_logratio), 6),  # 比例最近（容忍浮点噪声）
            abs(math.log(wh[0] * wh[1]) - req_logpx),  # 同比例内取像素最近
        ),
    )
    return f"{best[0]}x{best[1]}"


def _min_pixels_for_seedream(model: str) -> int:
    """seedream 族的最小像素约束 —— 实测值表，按模型 id 子串取。

    3686400：Tuzi 的 doubao-seedream-4-5、词元跳动的 seedream-5.0-lite（1024² 与 960²
    都被拒，报 must be at least 3686400 pixels）。
    921600：词元跳动的 seedream-5.0-pro（960² 通过，实测 88s 出图）。
    """
    if "seedream-5-0-pro" in normalized_model_id(model):
        return 921_600
    return 3_686_400


def _max_pixels_for_seedream(model: str) -> int:
    """seedream 族的最大像素约束 —— 与下限对称，同样是模型属性、同样按实测值表取。

    16777216（=4096²）：doubao-seedream-4-5（火山直连 / Tuzi）、词元跳动 seedream-5.0-lite。
    4624220：词元跳动 seedream-5.0-pro —— 不到别人的三分之一。Studio 的 4K 档最小的一挡
    4096x2304 就有 9437184 像素，是它上限的两倍，所以选 4K 必报
    `image area must be at most 4624220 pixels`（2026-08-14 实测，画师侧现象就是这条）。
    """
    if "seedream-5-0-pro" in normalized_model_id(model):
        return 4_624_220
    return 16_777_216


def _size_pixels(size: object) -> int:
    match = re.fullmatch(r"(\d+)x(\d+)", str(size).strip()) if size is not None else None
    return int(match.group(1)) * int(match.group(2)) if match else 0


def _normalize_size_for_provider(size: object, is_seedream: bool, model: str = "") -> object:
    # seedream 族的像素约束是**双向**的：低于下限厂商报「must be at least N pixels」，高于
    # 上限报「must be at most N pixels」，两条都在参数校验阶段直接 400。等比缩放到区间内，
    # 其余族原样返回。
    if not is_seedream or not isinstance(size, str):
        return size
    match = re.fullmatch(r"(\d+)x(\d+)", size.strip())
    if not match:
        return size
    width = int(match.group(1))
    height = int(match.group(2))
    pixels = max(1, width * height)
    min_pixels = _min_pixels_for_seedream(model)
    max_pixels = _max_pixels_for_seedream(model)
    if pixels < min_pixels:
        # 向上取整：放大后仍差一个像素会被继续判为不足。
        scale = (min_pixels / pixels) ** 0.5
        return f"{int(width * scale + 0.999999)}x{int(height * scale + 0.999999)}"
    if pixels > max_pixels:
        # 向下取整：缩小后多一个像素就仍然越界。
        scale = (max_pixels / pixels) ** 0.5
        return f"{max(1, int(width * scale))}x{max(1, int(height * scale))}"
    return size


def normalize_image_pixel_size(model: str, size: str) -> str:
    """Canvas preferences can outlive model ordering, so reapply the final family's limits."""
    match = re.fullmatch(r"(\d+)x(\d+)", size.strip())
    if not match:
        return size
    width, height = (int(value) for value in match.groups())
    if width <= 0 or height <= 0:
        return size
    family = image_family(model)
    if family == "seedream":
        return str(_normalize_size_for_provider(size, True, model))
    if family != "gpt-image":
        return size

    max_edge = 3_840
    min_pixels = 655_360
    max_pixels = 8_294_400
    edge = max(width, height)
    if edge > max_edge:
        scale = max_edge / edge
        width *= scale
        height *= scale
    pixels = width * height
    if pixels > max_pixels:
        scale = math.sqrt(max_pixels / pixels)
        width *= scale
        height *= scale
    elif pixels < min_pixels:
        scale = math.sqrt(min_pixels / pixels)
        width *= scale
        height *= scale
    rounded_width = max(16, int(width / 16 + 0.5) * 16)
    rounded_height = max(16, int(height / 16 + 0.5) * 16)
    return f"{rounded_width}x{rounded_height}"


def _chat_image_payload(
    *,
    prompt: str,
    model: str,
    size: str | None,
    image_paths: list[str] | None = None,
) -> dict:
    text = prompt
    if size:
        text = f"{text}\n\nImage size: {size}"
    if image_paths:
        content: object = []
        for p in image_paths:
            content.append({"type": "image_url", "image_url": {"url": _image_data_url(p)}})
        content.append({"type": "text", "text": text})
    else:
        content = text
    return {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
    }


def _chat_payload_to_image_payload(payload: dict) -> dict:
    data: list[dict[str, str]] = []
    for choice in payload.get("choices") or []:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            data.extend(_image_items_from_text(content))
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                text = part.get("text")
                if isinstance(text, str):
                    data.extend(_image_items_from_text(text))
                image_url = part.get("image_url")
                if isinstance(image_url, dict) and isinstance(image_url.get("url"), str):
                    data.append({"url": image_url["url"]})
    if data:
        return {"data": data}
    raise OpenAIImageError(f"chat image response missing image content: {payload!r}")


def _image_items_from_text(text: str) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for value in re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text):
        items.append(_image_item_from_value(value))
    for value in re.findall(r"https?://[^\s)\"']+", text):
        url = _clean_image_url(value)
        if not any(url == item.get("url") for item in items):
            items.append({"url": url})
    for value in re.findall(r"data:image/[^;\s]+;base64,[A-Za-z0-9+/=\n\r]+", text):
        items.append({"b64_json": value})
    return items


def _image_item_from_value(value: str) -> dict[str, str]:
    if value.startswith("data:image/"):
        return {"b64_json": value}
    return {"url": _clean_image_url(value)}


def _clean_image_url(value: str) -> str:
    url = value.strip().strip("<>")
    if "](" in url:
        url = url.split("](", 1)[0]
    match = re.match(r"https?://[^\s\]\)\"'<>]+", url)
    if match:
        url = match.group(0)
    return url.rstrip(".,;")


def _download_image_url(url: str) -> bytes:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    last_error: BaseException | None = None

    try:
        resp = requests.get(url, headers=headers, timeout=180.0, stream=False)
        if resp.status_code >= 400:
            raise OpenAIImageError(f"download image {resp.status_code}: {url}")
        data = resp.content
        if data:
            return data
    except OpenAIImageError:
        raise
    except (IncompleteRead, requests.RequestException) as e:
        last_error = e

    content = bytearray()
    expected_total: int | None = None
    for _ in range(5):
        resume_offset = len(content)
        request_headers = dict(headers)
        if content:
            request_headers["Range"] = f"bytes={resume_offset}-"
        try:
            with requests.get(
                url,
                headers=request_headers,
                timeout=180.0,
                stream=True,
            ) as resp:
                if resp.status_code >= 400:
                    raise OpenAIImageError(f"download image {resp.status_code}: {url}")
                if content and not _response_matches_range(resp.status_code, resp.headers, resume_offset):
                    content.clear()
                expected_total = _expected_download_size(resp.headers, expected_total)
                for chunk in resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        content.extend(chunk)
                if content and (expected_total is None or len(content) >= expected_total):
                    return bytes(content)
        except OpenAIImageError:
            raise
        except (IncompleteRead, requests.RequestException) as e:
            partial = _incomplete_read_partial(e)
            if partial:
                content.extend(partial)
            last_error = e
    fallback = _curl_download_image_url(url, headers)
    if fallback is not None:
        return fallback
    if content and expected_total is None and _looks_like_image(content):
        return bytes(content)
    raise OpenAIImageError("download image failed after retries") from last_error


def _incomplete_read_partial(error: BaseException) -> bytes:
    if isinstance(error, IncompleteRead) and isinstance(error.partial, bytes):
        return error.partial
    for arg in getattr(error, "args", ()):
        if isinstance(arg, BaseException):
            partial = _incomplete_read_partial(arg)
            if partial:
                return partial
    return b""


def _curl_download_image_url(url: str, headers: Mapping[str, str]) -> bytes | None:
    try:
        result = subprocess.run(
            [
                "curl",
                "-sS",
                "-L",
                "--fail",
                "--retry",
                "5",
                "--max-time",
                "180",
                "-A",
                headers["User-Agent"],
                "-H",
                f"Accept: {headers['Accept']}",
                url,
            ],
            check=True,
            capture_output=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    if _looks_like_image(bytearray(result.stdout)):
        return result.stdout
    return None


def _expected_download_size(
    headers: Mapping[str, str],
    fallback: int | None,
) -> int | None:
    content_range = headers.get("Content-Range")
    if content_range and "/" in content_range:
        total = content_range.rsplit("/", 1)[1]
        if total.isdigit():
            return int(total)
    content_length = headers.get("Content-Length")
    if content_length and content_length.isdigit() and not content_range:
        return int(content_length)
    return fallback


def _response_matches_range(
    status_code: int,
    headers: Mapping[str, str],
    resume_offset: int,
) -> bool:
    if resume_offset == 0:
        return True
    content_range = headers.get("Content-Range")
    if status_code != 206 or not content_range:
        return False
    unit, _, remainder = content_range.partition(" ")
    if unit.lower() != "bytes" or "-" not in remainder:
        return False
    start = remainder.split("-", 1)[0]
    return start.isdigit() and int(start) == resume_offset


def _looks_like_image(content: bytearray) -> bool:
    return (
        content.startswith(b"\x89PNG\r\n\x1a\n")
        or content.startswith(b"\xff\xd8\xff")
        or content.startswith(b"GIF87a")
        or content.startswith(b"GIF89a")
        or content.startswith(b"RIFF")
    )
