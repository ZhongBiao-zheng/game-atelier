"""Crop/stitch contracts; synthetic pixels only, never a paid provider request."""
import pytest
from PIL import Image, ImageChops

from character_workflow.lib.keys import KeySpec
from character_workflow.lib.regional_image_edit import plan_regions, stitch_regions


def key():
    return KeySpec(alias="test", provider="custom", access_key="fake",
                   base_url="https://api.tu-zi.com/v1", created_at="2026-10-15")


def mask(size=(1200, 800), boxes=((30, 30, 50, 50),)):
    image = Image.new("L", size, 255)
    for box in boxes:
        image.paste(0, box)
    return image


def test_small_region_is_enclosed_in_context_and_upscaled_for_model():
    regions = plan_regions(mask(), key(), "gpt-image-2", feather=8)
    assert len(regions) == 1
    region = regions[0]
    x, y, w, h = region.crop
    assert min(w, h) >= 256
    assert x <= 22 and y <= 22 and x + w >= 58 and y + h >= 58
    assert min(region.work_size) >= 512
    assert region.work_size[0] * region.work_size[1] >= 655_360
    assert all(n % 16 == 0 for n in region.work_size)
    assert abs((w / h) / (region.work_size[0] / region.work_size[1]) - 1) < .005


def test_distant_regions_split_nearby_merge_without_filling_gap():
    selected = mask(boxes=((100, 100, 120, 120), (125, 100, 145, 120), (900, 600, 950, 650)))
    regions = plan_regions(selected, key(), "gpt-image-2", feather=0)
    assert len(regions) == 2
    assert regions[0].components == [1, 2]
    x, y, _, _ = regions[0].crop
    assert regions[0].weight.getpixel((122 - x, 110 - y)) == 0


def test_manual_groups_can_split_or_merge_without_losing_components():
    selected = mask(boxes=((100, 100, 120, 120), (125, 100, 145, 120), (900, 600, 950, 650)))
    assert len(plan_regions(selected, key(), "gpt-image-2", groups=[[1], [2], [3]])) == 3
    assert len(plan_regions(selected, key(), "gpt-image-2", groups=[[1, 2, 3]])) == 1
    for invalid in ([[1], [2]], [[1, 1], [2, 3]], [[1, 2, 3, 4]]):
        with pytest.raises(ValueError, match="分组"):
            plan_regions(selected, key(), "gpt-image-2", groups=invalid)


def test_feather_core_and_finite_support_and_exact_rgba_protection():
    source = Image.new("RGBA", (400, 300), (50, 90, 120, 0))
    source.putpixel((0, 0), (12, 30, 60, 183))
    regions = plan_regions(mask(source.size, ((100, 100, 120, 120),)), key(),
                           "gpt-image-2", feather=8)
    patches = [Image.new("RGBA", region.work_size, (255, 0, 0, 255)) for region in regions]
    result = stitch_regions(source, regions, patches)
    assert result.size == source.size
    assert result.getpixel((110, 110)) == (255, 0, 0, 255)
    # Premultiplied alpha: transition stays red rather than mixing hidden source RGB.
    r, g, b, a = result.getpixel((97, 110))
    assert (r, g, b) == (255, 0, 0) and 0 < a < 255
    for point in ((0, 0), (91, 110), (128, 110), (200, 200)):
        assert result.getpixel(point) == source.getpixel(point)


def test_manual_separate_overlapping_bands_are_order_independent():
    selected = mask((400, 300), ((100, 100, 120, 120), (125, 100, 145, 120)))
    regions = plan_regions(selected, key(), "gpt-image-2", groups=[[1], [2]], feather=12)
    patches = [Image.new("RGBA", region.work_size, color)
               for region, color in zip(regions, ("red", "blue"))]
    source = Image.new("RGBA", selected.size, "green")
    a = stitch_regions(source, regions, patches)
    b = stitch_regions(source, list(reversed(regions)), list(reversed(patches)))
    assert ImageChops.difference(a, b).getbbox() is None


def test_edge_padding_and_model_specific_sizes_do_not_distort_coordinates():
    selected = mask((90, 70), ((0, 0, 10, 10),))
    for model in ("gpt-image-2", "doubao-seedream-4-5", "nano-banana-pro"):
        regions = plan_regions(selected, key(), model, feather=0)
        region = regions[0]
        if "seedream" in model:
            assert region.work_size[0] * region.work_size[1] >= 3_686_400
        result = stitch_regions(Image.new("RGBA", selected.size, "green"), regions,
                                [Image.new("RGBA", region.work_size, "red")])
        assert result.getpixel((0, 0)) == (255, 0, 0, 255)
        assert result.getpixel((11, 11)) == (0, 128, 0, 255)


def test_empty_selection_and_wrong_output_aspect_are_rejected():
    with pytest.raises(ValueError, match="选区"):
        plan_regions(Image.new("L", (400, 300), 255), key(), "gpt-image-2")
    regions = plan_regions(mask((400, 300)), key(), "gpt-image-2")
    with pytest.raises(ValueError, match="比例"):
        stitch_regions(Image.new("RGBA", (400, 300)), regions,
                       [Image.new("RGBA", (2000, 100))])


def test_antialias_pixels_and_holes_are_not_lost():
    selected = mask((400, 300), ((100, 100, 150, 150),))
    selected.paste(255, (110, 110, 140, 140))
    selected.putpixel((99, 100), 254)
    region = plan_regions(selected, key(), "gpt-image-2", feather=0)[0]
    x, y, _, _ = region.crop
    assert region.weight.getpixel((99 - x, 100 - y)) > 0
    assert region.weight.getpixel((125 - x, 125 - y)) == 0


def test_detects_confident_context_translation_but_does_not_guess_on_flat_floor():
    import random
    from PIL import ImageDraw
    from character_workflow.lib.regional_image_edit import validate_context_alignment
    source = Image.new("RGBA", (512, 512), "white")
    draw = ImageDraw.Draw(source)
    randomizer = random.Random(5)
    for _ in range(100):
        x, y = randomizer.randrange(480), randomizer.randrange(480)
        draw.rectangle((x, y, x + 20, y + 30), fill=(30, 40, 50, 255))
    protected = Image.new("L", source.size, 255)
    protected.paste(0, (200, 200, 300, 300))
    with pytest.raises(ValueError, match="位移"):
        validate_context_alignment(source, ImageChops.offset(source, 16, 0), protected)
    validate_context_alignment(source, source, protected)
    validate_context_alignment(Image.new("RGBA", source.size, "white"),
                               Image.new("RGBA", source.size, "gray"), protected)
