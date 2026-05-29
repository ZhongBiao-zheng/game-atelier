from character_workflow.lib.callers import zhenzhen_protocols as zp


def test_detect_protocol_gpt_size():
    assert zp.detect_image_protocol("gpt-image-2-all") == zp.ImageProtocol.GPT_SIZE


def test_detect_protocol_banana_ratio():
    assert zp.detect_image_protocol("nano-banana-pro") == zp.ImageProtocol.BANANA_RATIO


def test_detect_protocol_mj():
    assert zp.detect_image_protocol("midjourney") == zp.ImageProtocol.MJ


def test_detect_protocol_fal():
    assert zp.detect_image_protocol("gpt-image-2-fal") == zp.ImageProtocol.FAL


def test_aspect_to_gpt_size_matches_t8_map():
    assert zp.aspect_to_gpt_size("16:9", "2K") == "2560x1440"
    assert zp.aspect_to_gpt_size("9:16", "1K") == "720x1280"
    assert zp.aspect_to_gpt_size("Auto", "2K") == "auto"


def test_build_gpt_size_fields_uses_white_image_when_no_refs():
    fields = zp.build_gpt_size_fields(
        prompt="a fox",
        model="gpt-image-2-all",
        n=1,
        aspect_ratio="1:1",
        image_size="2K",
        size=None,
        quality=None,
        refs=[],
    )

    assert fields.text == {
        "prompt": "a fox",
        "model": "gpt-image-2-all",
        "n": "1",
        "quality": "auto",
        "moderation": "auto",
        "size": "2048x2048",
        "aspectRatio": "1:1",
        "resolution": "2k",
    }
    assert fields.needs_white_placeholder is True


def test_build_banana_json_payload_for_text_to_image():
    payload = zp.build_banana_json_payload(
        prompt="a penguin",
        model="nano-banana-pro",
        n=2,
        aspect_ratio="16:9",
        image_size="4K",
    )

    assert payload == {
        "prompt": "a penguin",
        "model": "nano-banana-pro",
        "n": 2,
        "aspect_ratio": "16:9",
        "image_size": "4K",
    }


def test_build_mj_payload_keeps_t8_fields():
    payload = zp.build_mj_payload(
        prompt="castle --v 8.1 --ar 16:9",
        base64_array=[],
        ar="16:9",
        seed=123,
    )

    assert payload["prompt"] == "castle --v 8.1 --ar 16:9"
    assert payload["base64Array"] == []
    assert payload["ar"] == "16:9"
    assert payload["seed"] == 123
    assert payload["remix"] is True
