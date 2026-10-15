import base64
import io

from PIL import Image
import pytest

from character_workflow.lib.callers import mj_edit
from tests.test_mj_image import mj_key, _FakeResp  # noqa: F401


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


def test_action_waits_for_modal_and_does_not_repeat_submit_on_resume(mj_key, monkeypatch):
    path = mj_key / "mask.png"
    Image.new("L", (32, 32), 0).save(path)
    action = "MJ::JOB::inpaint::1::uuid"
    monkeypatch.setattr(mj_edit, "fetch_task", lambda *_: {
        "status": "SUCCESS", "buttons": [{"customId": action}],
    })
    posts = []
    monkeypatch.setattr(mj_edit.mj.requests, "post", lambda url, **kwargs: (
        posts.append((url, kwargs["json"])) or _FakeResp(200, {"code": 21, "result": "child"})
    ))
    def responses(**kwargs):
        for status in ["SUBMITTED", "MODAL", "IN_PROGRESS", "SUCCESS"]:
            yield _FakeResp(200, {"status": status, "imageUrl": "https://cdn.test/a.png"})
    monkeypatch.setattr(mj_edit.mj.video_poll, "poll_responses", responses)
    monkeypatch.setattr(mj_edit.mj, "_download_png", lambda *_args, **_kw: str(path))
    params = {"image_edit": {"mode": "inpaint", "task_id": "source", "single": True,
                              "image_index": 1, "custom_id": action}, "mask_image": str(path)}
    mj_edit.render(prompt="red", model="midjourney", alias="mj", output_dir=mj_key, params=params)
    assert [url.rsplit("/", 1)[1] for url, _ in posts] == ["action", "modal"]
    assert posts[1][1]["maskBase64"].startswith("data:image/png;base64,")
    mj_edit.render(prompt="red", model="midjourney", alias="mj", output_dir=mj_key, params=params)
    assert len(posts) == 2


def test_uncertain_mj_submission_never_posts_again(mj_key, monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("must not resubmit")
    monkeypatch.setattr(mj_edit.mj.requests, "post", forbidden)
    with pytest.raises(mj_edit.mj.MidjourneyError, match="不会重复"):
        mj_edit.render(prompt="p", model="midjourney", alias="mj", output_dir=mj_key,
                       params={"image_edit": {}, "mj_edit_state": {"uncertain": True}})
