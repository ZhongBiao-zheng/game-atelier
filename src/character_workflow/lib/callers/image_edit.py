"""Bounded image editing, independent of the provider's mask fidelity."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .openai_image import image_family, supports_image_mask


def edit_transport(provider: str, model: str, protocol: str | None) -> str | None:
    if provider == "evolink":
        return "evolink" if model == "mj-v8.2" and protocol in {None, "evolink"} else None
    family = image_family(model)
    if family == "midjourney":
        return "mj"
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
    target = result.with_suffix(".png")
    Image.composite(base, generated, mask).save(target, format="PNG")
    return target


def render(*, prompt: str, model: str, alias: str, output_dir: Path,
           params: dict[str, Any], **kwargs) -> list[str]:
    from character_workflow.lib import keys
    from . import dispatch
    from .openai_image import _effective_image_protocol

    options = params["image_edit"]
    if params.get("regional_edit"):
        from .regional_edit import render as render_regions
        return render_regions(prompt=prompt, model=model, alias=alias, output_dir=output_dir,
                              params=params, **kwargs)
    kwargs.pop("durable_dir", None)
    validate_result = kwargs.pop("validate_result", None)
    key = keys.find_by_alias(alias)
    if key is None:
        raise ValueError("编辑模型的密钥已经不存在")
    transport = edit_transport(key.provider, model, _effective_image_protocol(key, model))
    if transport == "evolink":
        from .evolink import render as render_evolink
        return render_evolink(prompt=prompt, model=model, alias=alias, output_dir=output_dir,
                             params=params, **kwargs)
    if transport == "mj":
        from .mj_edit import render as render_mj
        return render_mj(prompt=prompt, model=model, alias=alias, output_dir=output_dir,
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
        guide = base.copy()
        overlay = Image.new("RGBA", base.size, (212, 165, 116, 255))
        guide = Image.composite(overlay, guide, edit_mask.point(lambda value: value // 2))
        guide_path = work / "selection.png"
        guide.save(guide_path)
        refs.insert(1, str(guide_path))
        request.pop("mask_image", None)
        instruction += (
            "Image 1 is the clean source. Image 2 marks the editable region in amber; "
            "the marking is guidance only and must NOT appear in the result. "
        )
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

    paths = dispatch(prompt=instruction + "\n" + prompt, model=model, alias=alias,
                     output_dir=output_dir, params=request, on_params_changed=changed, **kwargs)
    changed()
    if validate_result:
        for path in paths:
            with Image.open(path) as opened:
                validate_result(ImageOps.exif_transpose(opened).convert("RGBA"))
    return [str(composite_result(source, mask_path, Path(path), options)) for path in paths]
