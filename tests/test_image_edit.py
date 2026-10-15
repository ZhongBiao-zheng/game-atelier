"""Image editing contracts: no provider calls or paid generation."""
import pytest
from PIL import Image

from character_workflow.lib.callers import image_edit


def test_composite_preserves_rgba_outside_mask(tmp_path):
    source = Image.new("RGBA", (32, 24), (40, 60, 80, 0))
    source.putpixel((0, 0), (10, 20, 30, 180))
    source.save(tmp_path / "source.png")
    mask = Image.new("L", source.size, 255)
    mask.paste(0, (8, 8, 16, 16))
    mask.save(tmp_path / "mask.png")
    Image.new("RGB", source.size, "red").save(tmp_path / "result.png")
    image_edit.composite_result(tmp_path / "source.png", tmp_path / "mask.png",
                                tmp_path / "result.png", {})
    with Image.open(tmp_path / "result.png") as result:
        assert result.getpixel((0, 0)) == source.getpixel((0, 0))
        assert result.getpixel((20, 20)) == (40, 60, 80, 0)
        assert result.getpixel((10, 10)) == (255, 0, 0, 255)


def test_expansion_preserves_source_transparency_and_position(tmp_path):
    source = Image.new("RGBA", (32, 24), (1, 2, 3, 0))
    source.save(tmp_path / "source.png")
    options = {"mode": "outpaint", "width": 64, "height": 32, "x": 20, "y": 4}
    base, mask = image_edit.expanded_source(tmp_path / "source.png", options)
    assert base.size == (64, 32)
    assert mask.getpixel((20, 4)) == 255
    assert mask.getpixel((0, 0)) == 0
    mask.save(tmp_path / "mask.png")
    Image.new("RGB", base.size, "red").save(tmp_path / "result.png")
    image_edit.composite_result(tmp_path / "source.png", tmp_path / "mask.png",
                                tmp_path / "result.png", options)
    with Image.open(tmp_path / "result.png") as result:
        assert result.getpixel((20, 4)) == (1, 2, 3, 0)
        assert result.getpixel((0, 0)) == (255, 0, 0, 255)


def test_mismatching_result_aspect_is_rejected(tmp_path):
    for name, size in [("source", (32, 24)), ("result", (32, 32)), ("mask", (32, 24))]:
        Image.new("RGBA", size).save(tmp_path / f"{name}.png")
    with pytest.raises(ValueError, match="比例"):
        image_edit.composite_result(tmp_path / "source.png", tmp_path / "mask.png",
                                    tmp_path / "result.png", {})


@pytest.mark.parametrize("options", [
    {"width": 16, "height": 24, "x": 0, "y": 0},
    {"width": 64, "height": 24, "x": -1, "y": 0},
    {"width": 20000, "height": 20000, "x": 0, "y": 0},
])
def test_expansion_rejects_crop_and_excessive_canvas(tmp_path, options):
    source = tmp_path / "source.png"
    Image.new("RGBA", (32, 24)).save(source)
    with pytest.raises(ValueError):
        image_edit.expanded_source(source, options)


def test_capabilities_distinguish_masks_guides_and_native_mj():
    assert image_edit.edit_transport("custom", "gpt-image-2", "openai") == "mask"
    assert image_edit.edit_transport("seedream", "doubao-seedream-5-0-pro", "seedream") == "guide"
    assert image_edit.edit_transport("custom", "nano-banana-pro", "openai") == "guide"
    assert image_edit.edit_transport("midjourney", "midjourney", None) == "mj"
    assert image_edit.edit_transport("custom", "unknown-image", None) is None
