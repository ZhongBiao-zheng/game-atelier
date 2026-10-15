import base64
import io

from PIL import Image

from character_workflow.lib.callers import mj_edit


def test_actions_are_filtered_by_single_image_and_actual_buttons():
    buttons = [
        {"customId": "MJ::JOB::upsample::2::uuid", "label": "U2"},
        {"customId": "MJ::JOB::upsample::1::uuid", "label": "U1"},
        {"customId": "MJ::JOB::inpaint::1::uuid", "label": "Vary (Region)"},
        {"customId": "MJ::JOB::zoom::50::uuid", "label": "Zoom Out 2x"},
    ]
    assert [a["kind"] for a in mj_edit.actions(buttons, 2, False)] == ["prepare"]
    assert {a["kind"] for a in mj_edit.actions(buttons, 1, True)} == {"inpaint", "outpaint"}


def test_mj_mask_polarity_is_white_edit_black_preserve(tmp_path):
    mask = Image.new("L", (16, 16), 255)
    mask.putpixel((3, 4), 0)
    mask.save(tmp_path / "mask.png")
    encoded = mj_edit.mask_base64(tmp_path / "mask.png")
    with Image.open(io.BytesIO(base64.b64decode(encoded.split(",")[1]))) as result:
        assert result.getpixel((0, 0)) == 0
        assert result.getpixel((3, 4)) == 255
