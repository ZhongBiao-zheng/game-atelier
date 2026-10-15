"""Deterministic crop/stitch geometry. Coordinates always refer to oriented source pixels."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageMath, ImageOps, ImageStat

from .canvas_image_edits import edit_size_params
from .image_size_catalog import image_size_options
from .callers.openai_image import image_family


@dataclass
class Region:
    id: str
    components: list[int]
    bounds: tuple[int, int, int, int]
    crop: tuple[int, int, int, int]
    work_size: tuple[int, int]
    params: dict
    feather: int
    mask: Image.Image  # canonical generation mask: white protects, black edits
    weight: Image.Image  # stitch weight: white replaces, black preserves

    def descriptor(self) -> dict:
        return {name: getattr(self, name) for name in (
            "id", "components", "bounds", "crop", "work_size", "params", "feather",
        )}


def _components(mask: Image.Image) -> list[list[tuple[int, int, int]]]:
    """Run-length connected components: bounded by selection complexity, not a Python pixel graph."""
    width, height = mask.size
    data = ImageOps.invert(mask.convert("L")).tobytes()
    parents: list[int] = []
    runs: list[tuple[int, int, int, int]] = []
    previous: list[tuple[int, int, int]] = []

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for y in range(height):
        current = []
        start = 0
        for match in re.finditer(rb"[^\x00]+", data[y * width:(y + 1) * width]):
            left, right = match.span()
            label = len(parents)
            parents.append(label)
            while start < len(previous) and previous[start][1] < left:
                start += 1
            for a, b, other in previous[start:]:
                if a > right:
                    break
                parents[root(other)] = root(label)
            current.append((left, right, label))
            runs.append((y, left, right, label))
            if len(runs) > 200_000:
                raise ValueError("选区过于零碎，请简化涂抹后重试")
        previous = current
    grouped: dict[int, list] = {}
    for y, left, right, label in runs:
        grouped.setdefault(root(label), []).append((y, left, right))
    if not grouped:
        raise ValueError("请先绘制选区")
    if len(grouped) > 128:
        raise ValueError("选区超过 128 块，请合并涂抹后重试")
    return sorted(grouped.values(), key=lambda rows: (rows[0][0], rows[0][1]))


def _bounds(rows):
    return (min(r[1] for r in rows), min(r[0] for r in rows),
            max(r[2] for r in rows), max(r[0] for r in rows) + 1)


def _auto_groups(components):
    groups = [[i + 1] for i in range(len(components))]
    def bounds(group):
        return _bounds([row for i in group for row in components[i - 1]])
    changed = True
    while changed:
        changed = False
        for i, first in enumerate(groups):
            a, b, c, d = bounds(first)
            for j in range(i + 1, len(groups)):
                e, f, g, h = bounds(groups[j])
                distance = math.hypot(max(a - g, e - c, 0), max(b - h, f - d, 0))
                threshold = max(12, min(c - a, d - b, g - e, h - f) * .25)
                union_area = (max(c, g) - min(a, e)) * (max(d, h) - min(b, f))
                members = [_bounds(components[k - 1]) for k in first + groups[j]]
                # Bound total span against original components, not the ever-growing group.
                max_span = max(max(right - left, bottom - top)
                               for left, top, right, bottom in members)
                if (distance <= threshold
                        and max(max(c, g) - min(a, e), max(d, h) - min(b, f)) <= 4 * max_span
                        and union_area <= 1.6 * ((c - a) * (d - b) + (g - e) * (h - f))):
                    groups[i] = sorted(first + groups.pop(j))
                    changed = True
                    break
            if changed:
                break
    return groups


def _work_options(key, model):
    ratios = image_size_options(key.provider, key.base_url, model)["ratios"]
    # Older OpenAI image models accept only these three output shapes.
    bare = model.rsplit("/", 1)[-1]
    if bare in {"gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5"}:
        ratios = ["1:1", "3:2", "2:3"]
    result = []
    for ratio in ratios:
        if ":" not in ratio:
            continue
        a, b = map(float, ratio.split(":"))
        if image_family(model) == "gpt-image" and max(a / b, b / a) > 3:
            continue
        side = 2048 if image_family(model) == "seedream" else 1024
        scale = side / math.sqrt(a * b)
        width, height = round(a * scale / 16) * 16, round(b * scale / 16) * 16
        if bare in {"gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5"}:
            width, height = {"1:1": (1024, 1024), "3:2": (1536, 1024),
                             "2:3": (1024, 1536)}[ratio]
        try:
            params = edit_size_params(key, model, width, height)
        except ValueError:
            continue
        if "x" in str(params.get("size")):
            width, height = map(int, params["size"].split("x"))
        else:
            # Ratio APIs choose actual pixels; give them an undistorted input of that ratio.
            width, height = round(a * scale), round(b * scale)
        result.append(((width, height), params))
    if not result:
        raise ValueError("当前渠道没有可用的局部编辑尺寸")
    return result


def plan_regions(mask: Image.Image, key, model: str, *, context: float = .25,
                 feather: int | None = None, groups: list[list[int]] | None = None) -> list[Region]:
    if not 0 <= context <= 2 or (feather is not None and not 0 <= feather <= 32):
        raise ValueError("周围范围或边缘融合参数无效")
    components = _components(mask)
    if groups is None:
        groups = _auto_groups(components)
    flattened = [i for group in groups for i in group]
    if (sorted(flattened) != list(range(1, len(components) + 1))
            or any(not group for group in groups) or len(groups) > 16):
        raise ValueError("分组必须完整包含所有选区且不能重复，最多 16 组")
    options = _work_options(key, model)
    result = []
    for group in groups:
        rows = [row for i in group for row in components[i - 1]]
        left, top, right, bottom = _bounds(rows)
        w, h = right - left, bottom - top
        band = feather if feather is not None else max(4, min(24, round(min(w, h) * .04)))
        padding = max(16, math.ceil(max(w, h) * context)) + band
        min_w, min_h = max(256, w + padding * 2), max(256, h + padding * 2)
        choices = []
        for work, params in options:
            ratio = work[0] / work[1]
            ch = math.ceil(max(min_h, min_w / ratio))
            cw = math.ceil(ch * ratio)
            choices.append((cw * ch, cw, ch, work, params))
        _, cw, ch, work, params = min(choices, key=lambda item: item[0])
        if cw * ch > 64_000_000:
            raise ValueError("裁片超过 6400 万像素，请拆开选区")
        x, y = round((left + right - cw) / 2), round((top + bottom - ch) / 2)
        x = min(max(x, 0), mask.width - cw) if cw <= mask.width else x
        y = min(max(y, 0), mask.height - ch) if ch <= mask.height else y
        core = Image.new("L", (cw, ch))
        for row_y, a, b in rows:
            core.paste(255, (a - x, row_y - y, b - x, row_y - y + 1))
        weight = core.copy()
        grown = core
        for distance in range(1, band + 1):
            grown = grown.filter(ImageFilter.MaxFilter(3))
            t = 1 - distance / (band + 1)
            value = round(255 * t * t * (3 - 2 * t))
            weight = ImageChops.lighter(weight, grown.point(lambda p: value if p else 0))
        # The generation region includes the blend band; context outside is protected.
        generation = ImageOps.invert(weight.point(lambda p: 255 if p else 0))
        result.append(Region("-".join(map(str, sorted(group))), sorted(group),
                             (left, top, right, bottom), (x, y, cw, ch), work, params,
                             band, generation, weight))
    return result


def resize_rgba(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return image.convert("RGBA").convert("RGBa").resize(
        size, Image.Resampling.LANCZOS,
    ).convert("RGBA")


def validate_regional_tasks(state: dict, region_ids: list[str], count: int) -> None:
    """Validate imported/durable state before it can address files or submit orders."""
    error = "区域任务状态无效，请重新创建局部编辑"
    if (type(count) is not int or not 1 <= count <= 4 or not 1 <= len(region_ids) <= 16
            or len(set(region_ids)) != len(region_ids)
            or any(not isinstance(r, str) or not re.fullmatch(r"[0-9]+(?:-[0-9]+)*", r)
                   for r in region_ids)):
        raise ValueError(error)
    tasks = state.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != len(region_ids) * count:
        raise ValueError(error)
    pairs = set()
    for task in tasks:
        if (not isinstance(task, dict) or type(task.get("candidate")) is not int
                or not 0 <= task["candidate"] < count or task.get("region_id") not in region_ids
                or task.get("status") not in {"pending", "running", "succeeded", "failed", "paused", "uncertain"}):
            raise ValueError(error)
        pair = (task["candidate"], task["region_id"])
        if pair in pairs:
            raise ValueError(error)
        pairs.add(pair)
        provider = task.get("provider") or {}
        if not isinstance(provider, dict) or set(provider) - {"provider_task_ids", "provider_task_protocol", "warnings"}:
            raise ValueError(error)
    offset = state.get("output_offset", 0)
    if type(offset) is not int or offset < 0:
        raise ValueError(error)


def validate_context_alignment(source: Image.Image, generated: Image.Image,
                               protected: Image.Image) -> None:
    """Reject only confident translation in textured protected context; no semantic claims."""
    size = (128, max(32, round(128 * source.height / source.width)))
    a = source.convert("L").resize(size, Image.Resampling.BILINEAR)
    b = generated.convert("L").resize(size, Image.Resampling.BILINEAR)
    mask = ImageChops.multiply(protected, source.getchannel("A")).resize(
        size, Image.Resampling.NEAREST,
    ).point(lambda p: 255 if p == 255 else 0)
    # Exclude padding and wrap-around introduced by the diagnostic offset.
    inside = Image.new("L", size)
    ImageDraw.Draw(inside).rectangle((9, 9, size[0] - 10, size[1] - 10), fill=255)
    mask = ImageChops.multiply(mask, inside)
    if sum(mask.histogram()[1:]) < size[0] * size[1] * .15:
        return
    if ImageStat.Stat(a, mask).stddev[0] < 12:
        return
    a, b = a.filter(ImageFilter.FIND_EDGES), b.filter(ImageFilter.FIND_EDGES)
    if ImageStat.Stat(a, mask).mean[0] < 4:
        return
    baseline = ImageStat.Stat(ImageChops.difference(a, b), mask).mean[0]
    if baseline < 2:
        return
    best = (baseline, 0, 0)
    for dx in range(-8, 9):
        for dy in range(-8, 9):
            score = ImageStat.Stat(ImageChops.difference(a, ImageChops.offset(b, dx, dy)), mask).mean[0]
            if score < best[0]:
                best = (score, dx, dy)
    if best[0] < baseline * .55 and max(abs(best[1]), abs(best[2])) >= 3:
        raise ValueError("模型返回裁片的上下文出现明显位移；未回贴，请调整选区后重试")


def stitch_regions(source: Image.Image, regions: list[Region],
                   patches: list[Image.Image | None]) -> Image.Image:
    """Tile-local premultiplied accumulation; overlap is independent of region order."""
    if len(regions) != len(patches):
        raise ValueError("区域与结果数量不一致")
    source = source.convert("RGBA")
    result = source.copy()
    prepared = []
    tiles = set()
    for region, patch in zip(regions, patches):
        if patch is None:
            continue
        x, y, w, h = region.crop
        if abs((patch.width / patch.height) / (w / h) - 1) > .02:
            raise ValueError("模型返回裁片比例不一致；未回贴")
        patch = resize_rgba(patch, (w, h)).convert("RGBa")
        prepared.append((region, patch))
        a, b, c, d = region.bounds
        for ty in range(max(0, b - region.feather) // 256,
                        math.ceil(min(source.height, d + region.feather) / 256)):
            for tx in range(max(0, a - region.feather) // 256,
                            math.ceil(min(source.width, c + region.feather) / 256)):
                tiles.add((tx, ty))
    # Stable summation order gives byte-identical results even for overlapping manual groups.
    prepared.sort(key=lambda item: item[0].id)
    for tx, ty in sorted(tiles):
        box = (tx * 256, ty * 256, min(source.width, (tx + 1) * 256),
               min(source.height, (ty + 1) * 256))
        original = source.crop(box)
        size = original.size
        sums = [Image.new("F", size) for _ in range(4)]
        total = Image.new("F", size)
        union = Image.new("L", size)
        failed_core = Image.new("L", size)
        for region, patch in zip(regions, patches):
            if patch is None:
                x, y, _, _ = region.crop
                local = (box[0] - x, box[1] - y, box[2] - x, box[3] - y)
                failed_core = ImageChops.lighter(failed_core, region.weight.crop(local).point(
                    lambda p: 255 if p == 255 else 0,
                ))
        for region, patch in prepared:
            x, y, w, h = region.crop
            if x >= box[2] or y >= box[3] or x + w <= box[0] or y + h <= box[1]:
                continue
            local = (box[0] - x, box[1] - y, box[2] - x, box[3] - y)
            weight = region.weight.crop(local)
            weight = ImageChops.subtract(weight, failed_core)
            union = ImageChops.lighter(union, weight)
            total = ImageMath.lambda_eval(lambda v: v["a"] + v["w"], a=total, w=weight)
            channels = patch.crop(local).split()
            for i in range(4):
                sums[i] = ImageMath.lambda_eval(
                    lambda v: v["a"] + v["c"] * v["w"], a=sums[i], c=channels[i], w=weight,
                )
        channels = []
        for i, original_channel in enumerate(original.convert("RGBa").split()):
            channels.append(ImageMath.lambda_eval(
                lambda v: ((v["s"] / (v["t"] + (v["t"] == 0))) * v["u"] / 255
                           + v["o"] * (255 - v["u"]) / 255 + .5),
                s=sums[i], t=total, u=union, o=original_channel,
            ).convert("L"))
        blended = Image.merge("RGBa", channels).convert("RGBA")
        # Restore *exact* original RGBA, including hidden RGB under alpha=0, outside support.
        result.paste(blended, box[:2], union.point(lambda p: 255 if p else 0))
    return result
