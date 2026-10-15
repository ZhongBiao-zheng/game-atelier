"""Durable per-region attempts under the parent Canvas job's existing key slot."""
from __future__ import annotations

import requests
from PIL import Image, ImageOps

from ..atomic_io import atomic_write_bytes
from ..regional_image_edit import (
    plan_regions, resize_rgba, stitch_regions, validate_context_alignment,
)


def render(*, prompt, model, alias, output_dir, durable_dir, params, **kwargs):
    from ..keys import find_by_alias
    from .image_edit import render as render_crop
    from .tuzi_async import TASK_PROTOCOL, TuziAsyncFailedError, TuziAsyncPendingError

    import io
    options = params["image_edit"]
    state = params["regional_edit"]
    persist = kwargs.pop("on_params_changed", lambda: None)
    cost_callback = kwargs.pop("on_cost_usd", None)
    should_cancel = kwargs.get("should_cancel", lambda: False)
    kwargs.pop("n", None)
    kwargs.pop("size", None)
    with Image.open(params["reference_images"][0]) as opened:
        source = ImageOps.exif_transpose(opened).convert("RGBA")
    with Image.open(params["mask_image"]) as mask:
        regions = plan_regions(mask, find_by_alias(alias), model,
                               context=options.get("context", .25),
                               feather=options.get("feather"), groups=options.get("groups"))
    # Metadata is server-authored and frozen at submission. Never silently replan paid work.
    import json
    if json.dumps([r.descriptor() for r in regions], sort_keys=True) != json.dumps(
        options["regions"], sort_keys=True,
    ):
        raise ValueError("区域规划与提交快照不一致，请重新打开编辑器")
    durable_dir.mkdir(parents=True, exist_ok=True)
    region_map = {r.id: r for r in regions}
    for task in state["tasks"]:
        if should_cancel():
            raise RuntimeError("已停止区域编辑")
        if task["status"] in {"succeeded", "failed", "uncertain"}:
            continue
        if task["status"] == "running":
            # Process died between submitting and recording the reply. Never guess it was free.
            task.update(status="uncertain", error="提交结果未确认，请核对厂商订单；未重新下单")
            persist()
            continue
        region = region_map[task["region_id"]]
        directory = durable_dir / f"{task['candidate']}-{region.id}"
        directory.mkdir(parents=True, exist_ok=True)
        x, y, width, height = region.crop
        # Out-of-image context is transparent padding, and the inverse crop records it exactly.
        crop = resize_rgba(source.crop((x, y, x + width, y + height)), region.work_size)
        crop_path, mask_path = directory / "source.png", directory / "mask.png"
        crop.save(crop_path)
        generation_mask = region.mask.resize(region.work_size, Image.Resampling.NEAREST)
        generation_mask.save(mask_path)
        region.weight.save(directory / "blend.png")
        request = {k: v for k, v in params.items() if k not in {
            "image_edit", "regional_edit", "reference_images", "mask_image", "n", "size",
            "size_mode", "ratio", "resolution", "custom_size", "actual_n", "actual_size",
            "actual_cost_cny", "estimated_cost_cny", "provider_task_ids", "provider_task_protocol",
        }}
        request.update(region.params)
        request.update(task.get("provider") or {})
        request.update(n=1, reference_images=[str(crop_path), *params["reference_images"][1:]],
                       mask_image=str(mask_path), image_edit={"mode": "inpaint"})
        task.update(status="running", error=None)
        persist()  # claim precedes the first external operation

        def changed():
            task["provider"] = {k: request[k] for k in (
                "provider_task_ids", "provider_task_protocol", "warnings",
            ) if k in request}
            persist()

        def cost(value):
            if not isinstance(value, (float, int)) or value < 0:
                return
            task["cost_usd"] = value
            if cost_callback:
                cost_callback(sum(t.get("cost_usd", 0) + t.get("past_cost_usd", 0)
                                  for t in state["tasks"]))
            persist()

        try:
            outputs = render_crop(
                prompt=options.get("region_prompts", {}).get(region.id, "").strip() or prompt,
                model=model, alias=alias, output_dir=directory, n=1,
                size=region.params["size"], params=request,
                validate_result=lambda result: validate_context_alignment(crop, result, generation_mask),
                on_params_changed=changed, on_cost_usd=cost, **kwargs,
            )
            changed()
            if not outputs:
                raise ValueError("模型未返回区域图片")
            with Image.open(outputs[0]) as opened:
                patch = ImageOps.exif_transpose(opened).convert("RGBA")
            if abs((patch.width / patch.height) / (width / height) - 1) > .02:
                raise ValueError("模型返回裁片比例不一致；未回贴")
            # The output is immutable and survives the job runner's temporary directory.
            buffer = io.BytesIO()
            patch.save(buffer, format="PNG")
            path = directory / "patch.png"
            atomic_write_bytes(path, buffer.getvalue())
            task.update(status="succeeded", path=str(path), actual_size=list(patch.size))
        except TuziAsyncPendingError as error:
            changed()
            task.update(status="paused", error=str(error))
        except (ValueError, TuziAsyncFailedError) as error:
            changed()
            task.update(status="failed", error=str(error))
        except Exception as error:
            changed()
            response = getattr(error, "response", None)
            known_rejection = (isinstance(error, requests.RequestException)
                               and response is not None and 400 <= response.status_code < 500)
            provider = task.get("provider") or {}
            resumable = (provider.get("provider_task_ids")
                         and provider.get("provider_task_protocol") == TASK_PROTOCOL)
            status = "failed" if known_rejection else "paused" if resumable else "uncertain"
            task.update(status=status, error=str(error))
        persist()
    if should_cancel():
        raise RuntimeError("已停止区域编辑；成功裁片已保存")
    successful = [t for t in state["tasks"] if t["status"] == "succeeded"]
    state["partial"] = len(successful) != len(state["tasks"])
    persist()
    if not successful:
        raise ValueError("所有区域均未完成；已保存各区状态，可核对订单后继续")
    paths = []
    for candidate in range(params.get("n") or 1):
        patches = []
        for region in regions:
            task = next(t for t in state["tasks"]
                        if t["region_id"] == region.id and t["candidate"] == candidate)
            patch = None
            if task["status"] == "succeeded":
                with Image.open(task["path"]) as opened:
                    patch = opened.convert("RGBA")
            patches.append(patch)
        path = output_dir / f"composite-{candidate}.png"
        stitch_regions(source, regions, patches).save(path)
        paths.append(str(path))
    return paths
