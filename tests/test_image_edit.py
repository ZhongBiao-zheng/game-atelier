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


def test_capabilities_distinguish_masks_and_guides():
    assert image_edit.edit_transport("custom", "gpt-image-2", "openai") == "mask"
    assert image_edit.edit_transport("seedream", "doubao-seedream-5-0-pro", "ark") == "guide"
    assert image_edit.edit_transport("custom", "nano-banana-pro", "openai") == "guide"
    assert image_edit.edit_transport("midjourney", "midjourney", None) is None
    assert image_edit.edit_transport("custom", "unknown-image", None) is None
    assert image_edit.edit_transport("custom", "gpt-image-2", "seedance") is None
    assert image_edit.edit_transport("custom", "gpt-image-2", "openrouter") is None


@pytest.mark.parametrize("model,transport", [("gpt-image-2", "mask"), ("nano-banana-pro", "guide")])
def test_render_uses_real_dispatch_and_never_persists_temp_references(tmp_path, monkeypatch, model, transport):
    from character_workflow.lib import keys
    from character_workflow.lib import callers
    key = keys.KeySpec(alias="test", provider="custom", access_key="fake",
                       base_url="https://api.tu-zi.com", created_at="2026-10-15")
    monkeypatch.setattr(keys, "find_by_alias", lambda _: key)
    source, mask = tmp_path / "source.png", tmp_path / "mask.png"
    Image.new("RGBA", (32, 32), (1, 2, 3, 0)).save(source)
    m = Image.new("L", (32, 32), 255)
    m.paste(0, (8, 8, 16, 16))
    m.save(mask)
    params = {"image_edit": {"mode": "inpaint"}, "reference_images": [str(source)],
              "mask_image": str(mask)}
    def dispatch(**kwargs):
        request = kwargs["params"]
        assert len(request["reference_images"]) == (1 if transport == "mask" else 2)
        assert ("mask_image" in request) == (transport == "mask")
        assert "image_edit" not in request
        if transport == "guide":
            with Image.open(request["reference_images"][1]) as guide:
                assert guide.mode == "L"
                assert guide.getpixel((0, 0)) == 0
                assert guide.getpixel((10, 10)) == 255
            assert "white" in kwargs["prompt"] and "black" in kwargs["prompt"]
        request["provider_task_ids"] = ["accepted"]
        kwargs["on_params_changed"]()
        output = tmp_path / "generated.png"
        Image.new("RGB", (32, 32), "red").save(output)
        return [str(output)]
    monkeypatch.setattr(callers, "dispatch", dispatch)
    paths = image_edit.render(prompt="red", model=model, alias="test", output_dir=tmp_path,
                              params=params)
    assert params["reference_images"] == [str(source)]
    assert params["provider_task_ids"] == ["accepted"]
    with Image.open(paths[0]) as output:
        assert output.getpixel((0, 0)) == (1, 2, 3, 0)
        assert output.getpixel((10, 10)) == (255, 0, 0, 255)


def test_inpaint_feathers_only_inside_selection_and_preserves_every_protected_pixel(tmp_path):
    source = Image.new("RGBA", (128, 128), (10, 20, 30, 80))
    source.save(tmp_path / "source.png")
    mask = Image.new("L", source.size, 255)
    mask.paste(0, (32, 32, 96, 96))
    mask.save(tmp_path / "mask.png")
    Image.new("RGBA", (256, 256), (240, 220, 200, 255)).save(tmp_path / "result.png")
    path = image_edit.composite_result(tmp_path / "source.png", tmp_path / "mask.png",
                                       tmp_path / "result.png", {"mode": "inpaint"})
    with Image.open(path) as result:
        assert result.size == source.size
        assert result.getpixel((64, 64)) == (240, 220, 200, 255)
        assert 10 < result.getpixel((32, 64))[0] < 240
        for y in range(128):
            for x in range(128):
                if mask.getpixel((x, y)) == 255:
                    assert result.getpixel((x, y)) == source.getpixel((x, y))


def test_mj_bypasses_regular_compositing(tmp_path, monkeypatch):
    from character_workflow.lib import keys
    from character_workflow.lib.callers import evolink
    key = keys.KeySpec(alias="Evo", provider="evolink", access_key="fake",
                       base_url="https://api.evolink.ai/v1", created_at="2026-10-16")
    monkeypatch.setattr(keys, "find_by_alias", lambda _: key)
    params = {"image_edit": {"mode": "inpaint"}}
    def render(**kwargs):
        assert kwargs["params"] is params
        return ["native-mj-output"]
    def forbidden(*args, **kwargs):
        raise AssertionError("MJ must not enter regular compositing")
    monkeypatch.setattr(evolink, "render", render)
    monkeypatch.setattr(image_edit, "composite_result", forbidden)
    assert image_edit.render(prompt="edit", model="mj-v8.2", alias="Evo",
                              output_dir=tmp_path, params=params) == ["native-mj-output"]
