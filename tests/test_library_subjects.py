from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import pytest
from PIL import Image

from character_workflow.lib import job_runner, library
from character_workflow.lib.library_subjects import expand
from character_workflow.lib.schemas import JobParams
from tests import test_studio_jobs

studio_client = test_studio_jobs.client


def seed_subject(name, description, count):
    row = library.subject(name, description)
    ids = []
    for i in range(count):
        image = BytesIO()
        Image.new("RGB", (2, 2), (i, ord(name[-1]) % 255, 90)).save(image, format="PNG")
        item = library.insert(row["id"], f"{name}{i}", image.getvalue(), "image", ".png", {"kind": "upload"})
        ids.append(item["id"])
    if ids:
        library.update(row["id"], {"cover_item_id": ids[-1]})
    return f"@[subject:{row['id']}:{quote(name)}]", ids


def test_round_robin_and_explicit_priority():
    a, a_ids = seed_subject("阿橙", "橙色短发", 3)
    b, b_ids = seed_subject("阿蓝", "蓝衣", 3)
    params = JobParams(reference_images=["explicit.png"])
    assert expand(f"{a}看向{b}，{a}挥手", params, "nano-banana") == "阿橙：橙色短发。\n阿蓝：蓝衣。\n阿橙看向阿蓝，阿橙挥手"
    assert params.reference_images[0] == "explicit.png"
    assert [s.item_ids for s in params.subjects] == [[a_ids[-1]], [b_ids[-1]]]
    assert params.warnings == ["@阿橙 只带上了 1/3 张参考", "@阿蓝 只带上了 1/3 张参考"]
    for frozen in params.subjects:
        library.remove(frozen.id)
    assert all(Path(path).exists() for path in params.reference_images[1:])
    with pytest.raises(ValueError, match="@阿橙 当前不可用"):
        expand(a, JobParams(), "gpt-image-2")


def test_submit_to_local_fake_model(studio_client, monkeypatch):
    token, ids = seed_subject("阿橙", "橙色短发少女", 1)
    captured = {}
    def fake_model(*, prompt, output_dir, params, **kwargs):
        captured.update(prompt=prompt, subjects=params["subjects"])
        output = Path(output_dir) / "local.png"
        Image.open(params["reference_images"][0]).save(output)
        return [str(output)]
    monkeypatch.setattr(job_runner, "dispatch", fake_model)
    response = studio_client.post("/api/studio/jobs", json={"prompt": token + "站在海边", "model": "gpt-image-2", "params": {}})
    assert response.status_code == 201, response.text
    job = job_runner.run_job(response.json()["job_id"])
    assert job.status == "done", job.error
    assert captured["prompt"] == "阿橙：橙色短发少女。\n阿橙站在海边"
    assert captured["subjects"][0]["item_ids"] == ids
    print(captured)


def test_canvas_reproduce_restores_chip_and_refreezes_only_subject_images():
    from character_workflow.lib.canvas_projects import canvas_project_lock_path, create_canvas_project, read_canvas_document
    from character_workflow.lib.canvas_runs import commit_canvas_generation_under_lock, prepare_canvas_generation
    from character_workflow.lib.file_lock import file_lock
    from character_workflow.lib.generation_recipe import recipe_params
    from tests.test_canvas_reproduce import _asset, _config, _configure_keys, _reproduce, _REF_A

    _configure_keys()
    token, ids = seed_subject("阿橙", "橙色短发", 1)
    project_id = create_canvas_project("主体复刻").project_id
    original = JobParams()
    expanded = expand(token, original, "gpt-image-2")
    params = recipe_params(original.model_dump(mode="json", exclude_none=True))
    asset = _asset([(_REF_A, "reference")], draft_prompt=token, final_prompt=expanded, params=params)
    _reproduce(project_id, asset.asset_id)
    document = read_canvas_document(project_id)
    config = _config(document)
    assert config.data.generation_draft.prompt == token
    prepared = prepare_canvas_generation(project_id, document, config)
    with file_lock(canvas_project_lock_path(project_id)):
        job, _ = commit_canvas_generation_under_lock(project_id, document, config, prepared)
    assert job.prompt.count("橙色短发") == 1
    assert job.params.subjects[0].item_ids == ids
    assert len(job.params.reference_images) == 2


def test_subject_description_does_not_add_images_to_explicit_video_frame_slots():
    token, _ = seed_subject("阿橙", "橙色短发", 2)
    params = JobParams(frame_mode="first", reference_images=["first.png"])
    assert expand(token, params, "seedance-2", mode="video") == "阿橙：橙色短发。\n阿橙"
    assert params.reference_images == ["first.png"]
    assert params.subjects[0].item_ids == []
    assert params.warnings == ["@阿橙 只带上了 0/2 张参考"]
