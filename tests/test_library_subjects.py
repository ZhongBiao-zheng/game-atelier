from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import pytest
from PIL import Image

from character_workflow.lib import job_runner, library
from character_workflow.lib.library_subjects import expand
from character_workflow.lib.schemas import JobParams
pytest_plugins = ["tests.test_studio_jobs"]


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


def test_submit_to_local_fake_model(client, monkeypatch):
    token, ids = seed_subject("阿橙", "橙色短发少女", 1)
    captured = {}
    def fake_model(*, prompt, output_dir, params, **kwargs):
        captured.update(prompt=prompt, subjects=params["subjects"])
        output = Path(output_dir) / "local.png"
        Image.open(params["reference_images"][0]).save(output)
        return [str(output)]
    monkeypatch.setattr(job_runner, "dispatch", fake_model)
    response = client.post("/api/studio/jobs", json={"prompt": token + "站在海边", "model": "gpt-image-2", "params": {}})
    assert response.status_code == 201, response.text
    job = job_runner.run_job(response.json()["job_id"])
    assert job.status == "done", job.error
    assert captured["prompt"] == "阿橙：橙色短发少女。\n阿橙站在海边"
    assert captured["subjects"][0]["item_ids"] == ids
    print(captured)
