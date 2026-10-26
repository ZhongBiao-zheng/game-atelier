"""Bounded image editing, independent of the provider's mask fidelity."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageFilter, ImageOps

from .openai_image import image_family, supports_image_mask


# 局部修改 / 扩图目前只开放实测过的型号：GPT Image 2.5 系列、Nano Banana 2 / 2.1、Seedream 5.0 pro（另加 EvoLink MJ）。
# 与前端 imageEditGeometry.ts 的 EDIT_MODEL_PATTERN 保持一致。
EDIT_MODEL_PATTERN = re.compile(r"^(gpt-image-2\.5(-[a-z0-9]+)?|(gemini-)?nano-banana-2(\.1)?(-[24]k)?|seedream-5\.0-pro|doubao-seedream-5-0-pro(-\d+)?)$")


def edit_transport(provider: str, model: str, protocol: str | None) -> str | None:
    if provider == "evolink":
        return "evolink" if model == "mj-v8.2" and protocol in {None, "evolink"} else None
    if not EDIT_MODEL_PATTERN.match(model.lower().rsplit("/", 1)[-1]):
        return None
    family = image_family(model)
    if family == "midjourney":
        return None
    protocols = {None, "openai", "openrouter"} if provider == "openrouter" else {None, "openai", "ark"}
    if protocol not in protocols:
        return None
    if supports_image_mask(provider, model, protocol):
        return "mask"
    if family in {"seedream", "nano-banana", "gpt-image"} and provider in {
        "openai", "custom", "seedream", "tokendance", "openrouter",
    }:
        return "guide"
    return None


def edit_transport_for_key(key, model: str) -> str | None:
    from .openai_image import _effective_image_protocol

    if key.provider == "atelier":
        spec = next((item for item in key.models if item.id == model), None)
        transports = [edit_transport(m.provider, m.model_id, m.protocol)
                      for m in (spec.via or [])] if spec else []
        return transports[0] if transports and all(transports) else None
    return edit_transport(key.provider, model, _effective_image_protocol(key, model))


def expanded_source(source: Path, options: dict) -> tuple[Image.Image, Image.Image]:
    with Image.open(source) as opened:
        original = ImageOps.exif_transpose(opened).convert("RGBA")
    width, height = int(options["width"]), int(options["height"])
    x, y = int(options["x"]), int(options["y"])
    if (min(width, height) < 1 or max(width, height) > 16384
            or width * height > 16_777_216 or min(x, y) < 0
            or x + original.width > width or y + original.height > height):
        raise ValueError("扩图边界必须完整包含原图，且不能超过 16384px 或 1600 万像素")
    if (width, height) == original.size:
        raise ValueError("请向外扩大画框")
    base = Image.new("RGBA", (width, height))
    base.paste(original, (x, y))
    mask = Image.new("L", base.size, 0)
    mask.paste(255, (x, y, x + original.width, y + original.height))
    return base, mask


# Seam band as a share of the source's short side: wide enough that a model's global tone
# shift fades out instead of showing as a hard line.
OUTPAINT_SEAM_RATIO = .03
OUTPAINT_SEAM_MAX = 64


def outpaint_seam_mask(options: dict, source_size: tuple[int, int]) -> Image.Image:
    """Keep the source, ramping into generated pixels only along edges that were extended."""
    width, height = int(options["width"]), int(options["height"])
    x, y = int(options["x"]), int(options["y"])
    w, h = source_size
    band = min(OUTPAINT_SEAM_MAX, max(1, round(min(w, h) * OUTPAINT_SEAM_RATIO)))
    ramp = [min(255, round(255 * (i + 1) / (band + 1))) for i in range(max(w, h))]
    alpha = Image.new("L", source_size, 255)
    for extended, length, vertical, reverse in [
        (x > 0, w, False, False), (x + w < width, w, False, True),
        (y > 0, h, True, False), (y + h < height, h, True, True),
    ]:
        if not extended:
            continue
        values = ramp[:length][::-1] if reverse else ramp[:length]
        strip = Image.new("L", (1, length) if vertical else (length, 1))
        strip.putdata(values)
        alpha = ImageChops.multiply(alpha, strip.resize(source_size, Image.Resampling.NEAREST))
    mask = Image.new("L", (width, height), 0)
    mask.paste(alpha, (x, y))
    return mask


def composite_result(source: Path, mask_path: Path, result: Path, options: dict) -> Path:
    if options.get("mode") == "outpaint":
        base, _ = expanded_source(source, options)
    else:
        with Image.open(source) as opened:
            base = ImageOps.exif_transpose(opened).convert("RGBA")
    with Image.open(mask_path) as opened:
        mask = opened.convert("L")
    if mask.size != base.size:
        raise ValueError("蒙版尺寸与编辑画框不一致")
    with Image.open(result) as opened:
        generated = ImageOps.exif_transpose(opened).convert("RGBA")
    if abs((generated.width / generated.height) / (base.width / base.height) - 1) > .02:
        raise ValueError("模型返回图片比例与编辑画框不一致，请调整尺寸后重试；原图未修改")
    if generated.size != base.size:
        generated = generated.resize(base.size, Image.Resampling.LANCZOS)
    if options.get("mode") == "outpaint":
        with Image.open(source) as opened:
            mask = outpaint_seam_mask(options, ImageOps.exif_transpose(opened).size)
    elif options.get("mode") == "inpaint":
        # Average inward erosions: a short transition wholly inside the selection.
        # Unlike Gaussian blur this cannot leak generated pixels into protected RGBA.
        selection = ImageOps.invert(mask)
        feathered = selection.copy()
        radius = min(8, max(1, round(min(base.size) / 256)))
        for step in range(1, radius + 1):
            selection = selection.filter(ImageFilter.MinFilter(3))
            feathered = Image.blend(feathered, selection, 1 / (step + 1))
        mask = ImageOps.invert(feathered)
    target = result.with_suffix(".png")
    Image.composite(base, generated, mask).save(target, format="PNG")
    return target


def _record_inputs(params: dict, work: Path, prompt: str, files: list[tuple[str, bytes]]) -> None:
    """Keep the exact provider payload images and prompt; the runner moves them next to outputs."""
    work.mkdir(parents=True, exist_ok=True)
    entries = []
    for index, (role, content) in enumerate(files):
        path = work / f"{index + 1}-{role}.png"
        path.write_bytes(content)
        entries.append({"role": role, "path": str(path)})
    params["edit_inputs"] = entries
    params["edit_prompt"] = prompt


def render(*, prompt: str, model: str, alias: str, output_dir: Path,
           params: dict[str, Any], **kwargs) -> list[str]:
    from character_workflow.lib import keys
    from . import dispatch
    from .openai_image import _effective_image_protocol

    options = params["image_edit"]
    validate_result = kwargs.pop("validate_result", None)
    key = keys.find_by_alias(alias)
    if key is None:
        raise ValueError("编辑模型的密钥已经不存在")
    if not key.enabled:
        raise ValueError("供应商已停用")
    transport = edit_transport(key.provider, model, _effective_image_protocol(key, model))
    if transport == "evolink":
        import base64

        from .evolink import _edit_source, mask_data_uri
        from .evolink import render as render_evolink
        if params.get("reference_images") and params.get("mask_image"):
            content, size = _edit_source(str(params["reference_images"][0]))
            mask = mask_data_uri(params["mask_image"], size).split(",", 1)[1]
            _record_inputs(params, output_dir / "edit-inputs", prompt.strip(),
                           [("source", content), ("mask", base64.b64decode(mask))])
        return render_evolink(prompt=prompt, model=model, alias=alias, output_dir=output_dir,
                             params=params, **kwargs)
    if not transport or not params.get("mask_image") or not params.get("reference_images"):
        raise ValueError("图片编辑缺少有效源图、蒙版或兼容模型")
    source = Path(params["reference_images"][0])
    mask_path = Path(params["mask_image"])
    work = output_dir / "edit-inputs"
    work.mkdir(parents=True, exist_ok=True)
    request = dict(params)
    request.pop("image_edit", None)
    refs = list(params["reference_images"])
    if options["mode"] == "outpaint":
        base, _ = expanded_source(source, options)
    else:
        with Image.open(source) as opened:
            base = ImageOps.exif_transpose(opened).convert("RGBA")
    input_path = work / "source.png"
    base.save(input_path)
    refs[0] = str(input_path)
    instruction = (
        "Extend only the new canvas area, continuing the scene naturally. "
        if options["mode"] == "outpaint" else "Edit only the selected region. "
    )
    instruction += "Keep image composition, camera, object positions and aspect ratio unchanged. "
    if transport == "guide":
        with Image.open(mask_path) as opened:
            edit_mask = ImageOps.invert(opened.convert("L"))
        if options["mode"] == "inpaint":
            guide = edit_mask
            instruction += (
                "Image 1 is the clean source. Image 2 is a selection mask: white marks "
                "the area to edit and black marks areas to preserve. Return the edited "
                "original only; do NOT reproduce the mask. "
            )
        else:
            overlay = Image.new("RGBA", base.size, (212, 165, 116, 255))
            guide = Image.composite(overlay, base, edit_mask.point(lambda value: value // 2))
            instruction += (
                "Image 1 is the clean source. Image 2 marks the editable region in amber; "
                "the marking is guidance only and must NOT appear in the result. "
            )
        guide_path = work / "selection.png"
        guide.save(guide_path)
        refs.insert(1, str(guide_path))
        request.pop("mask_image", None)
    else:
        instruction += "The supplied mask identifies the editable region. "
    if len(params["reference_images"]) > 1:
        instruction += "The last image is replacement content reference, not the base image. "
    request["reference_images"] = refs
    # Provider order/cost metadata is durable; temporary processing paths must never be saved.
    persist = kwargs.pop("on_params_changed", None)

    def changed():
        for field in ("provider_task_ids", "provider_task_protocol", "warnings",
                      "actual_cost_cny", "actual_n"):
            if field in request:
                params[field] = request[field]
        if persist:
            persist()

    final_prompt = instruction + "\n" + prompt
    if transport == "mask":
        from .openai_image import _normalized_edit_image, _normalized_edit_mask
        sent, size = _normalized_edit_image(input_path)
        sent_files = [("source", sent), ("mask", _normalized_edit_mask(mask_path, size))]
        sent_files += [("reference", _normalized_edit_image(Path(ref))[0]) for ref in refs[1:]]
    else:
        sent_files = [("source", input_path.read_bytes()), ("guide", guide_path.read_bytes())]
        sent_files += [("reference", Path(ref).read_bytes()) for ref in refs[2:]]
    _record_inputs(params, work / "sent", final_prompt, sent_files)
    paths = dispatch(prompt=final_prompt, model=model, alias=alias,
                     output_dir=output_dir, params=request, on_params_changed=changed, **kwargs)
    changed()
    if validate_result:
        for path in paths:
            with Image.open(path) as opened:
                validate_result(ImageOps.exif_transpose(opened).convert("RGBA"))
    return [str(composite_result(source, mask_path, Path(path), options)) for path in paths]
