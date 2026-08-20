from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.__main__ import main
from character_workflow.lib import keys
from character_workflow.lib.jobs import job_output_dir_for, read_job, save_job
from character_workflow.lib.projects import create_project
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
from character_workflow.lib.video_jobs import (
    create_production,
    list_productions,
    set_selected,
    shot_output_dir,
)
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root: Path) -> TestClient:
    return TestClient(build_app(dist_dir=isolated_data_root / "dist"))


def _seed_video_key() -> None:
    keys.write_keys_db(keys.KeysDB.model_validate({
        "version": 1,
        "default_alias": "video-main",
        "keys": [{
            "alias": "video-main",
            "provider": "seedance",
            "access_key": "ak_test",
            "secret_key": None,
            "capabilities": [],
            "modalities": ["video"],
            "models": [{
                "name": "Seedance 2.5",
                "id": "seedance-2-5-pro",
                "modality": "video",
                "protocol": "seedance",
            }],
            "created_at": "2026-08-20T00:00:00+08:00",
        }],
    }))


def test_create_production_writes_brief_and_shot_map(isolated_data_root: Path):
    project = create_project("三国")

    root = create_production(project.id, "launch-pv", "上线宣传片", "promo")

    assert root == isolated_data_root / "projects" / project.slug / "videos" / "launch-pv"
    assert 'title: "上线宣传片"' in (root / "brief.md").read_text(encoding="utf-8")
    assert (root / "shot-map.md").is_file()


def test_video_job_output_dir_is_project_shot(isolated_data_root: Path):
    project = create_project("三国")
    create_production(project.id, "launch-pv", "上线宣传片")
    job = Job(
        job_id="job-video-1",
        character_id="",
        prompt="镜头",
        submitted_at="2026-08-20T00:00:00Z",
        model="seedance-2.5",
        params=JobParams(),
        output_paths=[],
        status=JobStatus.PENDING_CONFIRM,
        error=None,
        kind=JobKind.VIDEO,
        namespace="video",
        project_id=project.id,
        production_id="launch-pv",
        shot_id="shot-01",
    )

    assert job_output_dir_for(job) == (
        isolated_data_root / "projects" / project.slug / "videos" / "launch-pv" / "shots" / "shot-01"
    )


def test_video_cli_creates_production_and_pending_shot_job(tmp_path: Path, capsys):
    project = create_project("三国", slug="sanguo")
    _seed_video_key()

    assert main([
        "create-video-production",
        "--project", project.id,
        "--production", "launch-pv",
        "--title", "上线宣传片",
        "--type", "promo",
    ]) == 0
    capsys.readouterr()

    prompt = tmp_path / "shot-01.txt"
    prompt.write_text("角色转身，镜头缓慢推进", encoding="utf-8")
    assert main([
        "submit-video-shot",
        "--project", project.id,
        "--production", "launch-pv",
        "--shot", "shot-01",
        "--prompt-file", str(prompt),
    ]) == 0

    captured = capsys.readouterr()
    job_id = captured.out.strip()
    job = read_job(job_id)
    assert job.status is JobStatus.PENDING_CONFIRM
    assert job.kind is JobKind.VIDEO
    assert job.namespace == "video"
    assert job.project_id == project.id
    assert job.production_id == "launch-pv"
    assert job.shot_id == "shot-01"
    assert job.alias == "video-main"
    assert job.model == "seedance-2-5-pro"
    assert "参数   : 5s · 720p · 16:9" in captured.err
    assert "参考视频: 0 个" in captured.err
    assert "参考音频: 0 个" in captured.err


def test_list_and_select_shot_versions(isolated_data_root: Path):
    project = create_project("三国")
    create_production(project.id, "launch-pv", "上线宣传片", "promo")
    output = shot_output_dir(project.id, "launch-pv", "shot-01") / "v1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")

    selected = set_selected(project.id, "launch-pv", "shot-01", str(output))
    productions = list_productions(project.id)

    expected = f"projects/{project.slug}/videos/launch-pv/shots/shot-01/v1.mp4"
    assert selected == {"shot-01": expected}
    assert productions[0].title == "上线宣传片"
    assert productions[0].shots[0].model_dump() == {
        "shot_id": "shot-01",
        "purpose": "",
        "duration": "",
        "status": "generated",
        "versions": [expected],
        "selected": expected,
        "prompt": "",
        "model": "",
        "reference_images": [],
        "reference_videos": [],
        "reference_audios": [],
    }
    assert productions[0].exports == []


def test_list_includes_planned_shots_before_generation(isolated_data_root: Path):
    project = create_project("三国")
    root = create_production(project.id, "launch-pv", "上线宣传片", "promo")
    (root / "shot-map.md").write_text(
        "---\nstatus: approved\n---\n\n"
        "| shot-id | 用途 | 时长 | 状态 |\n"
        "|---|---|---:|---|\n"
        "| shot-01 | 角色亮相 | 3s | planned |\n",
        encoding="utf-8",
    )
    (root / "brief.md").write_text(
        "---\ntitle: \"上线宣传片\"\ntype: promo\nstatus: draft\n---\n\n"
        "## 目标\n角色上线亮相\n\n## 平台\nB站\n\n## 画幅\n16:9\n\n"
        "## 目标时长\n30s\n\n## 声音策略\n音乐驱动\n",
        encoding="utf-8",
    )
    save_job(Job(
        job_id="job-video-metadata",
        character_id="",
        prompt="角色转身，镜头缓慢推进",
        submitted_at="2026-08-20T00:00:00Z",
        model="seedance-2.5-pro",
        params=JobParams(reference_images=["characters/hero/portrait/v1.png"]),
        output_paths=[],
        status=JobStatus.PENDING_CONFIRM,
        error=None,
        kind=JobKind.VIDEO,
        namespace="video",
        project_id=project.id,
        production_id="launch-pv",
        shot_id="shot-01",
    ))

    production = list_productions(project.id)[0]
    shot = production.shots[0]

    assert shot.shot_id == "shot-01"
    assert shot.purpose == "角色亮相"
    assert shot.duration == "3s"
    assert shot.versions == []
    assert shot.prompt == "角色转身，镜头缓慢推进"
    assert shot.model == "seedance-2.5-pro"
    assert shot.reference_images == ["characters/hero/portrait/v1.png"]
    assert production.brief.model_dump() == {
        "goal": "角色上线亮相",
        "platform": "B站",
        "ratio": "16:9",
        "duration": "30s",
        "sound": "音乐驱动",
    }


def test_video_ids_reject_path_traversal(isolated_data_root: Path):
    project = create_project("三国")

    with pytest.raises(ValueError):
        create_production(project.id, "../escape", "坏企划")


def test_video_namespace_requires_complete_ownership():
    with pytest.raises(ValueError, match="requires project_id"):
        Job(
            job_id="job-invalid-video",
            character_id="",
            prompt="镜头",
            submitted_at="2026-08-20T00:00:00Z",
            model="seedance-2.5",
            params=JobParams(),
            output_paths=[],
            status=JobStatus.PENDING_CONFIRM,
            error=None,
            kind=JobKind.VIDEO,
            namespace="video",
        )


def test_video_api_lists_productions_and_selects_version(client, isolated_data_root: Path):
    project = create_project("三国")
    create_production(project.id, "launch-pv", "上线宣传片")
    output = shot_output_dir(project.id, "launch-pv", "shot-01") / "v1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")
    relative = output.relative_to(isolated_data_root).as_posix()

    selected = client.post(
        f"/api/projects/{project.id}/videos/launch-pv/shots/shot-01/selected",
        json={"path": relative},
    )
    listed = client.get(f"/api/projects/{project.id}/videos")

    assert selected.status_code == 200
    assert selected.json() == {"shots": {"shot-01": relative}}
    assert listed.status_code == 200
    assert listed.json()["productions"][0]["shots"][0]["selected"] == relative


def test_video_api_does_not_create_missing_production_on_clear(client, isolated_data_root: Path):
    project = create_project("三国")

    response = client.post(
        f"/api/projects/{project.id}/videos/missing/shots/shot-01/selected",
        json={"path": None},
    )

    assert response.status_code == 404
    assert not (isolated_data_root / "projects" / project.slug / "videos" / "missing").exists()


def test_selected_version_rejects_non_mp4(isolated_data_root: Path):
    project = create_project("三国")
    create_production(project.id, "launch-pv", "上线宣传片")
    notes = shot_output_dir(project.id, "launch-pv", "shot-01") / "notes.md"
    notes.parent.mkdir(parents=True)
    notes.write_text("not a video", encoding="utf-8")

    with pytest.raises(ValueError, match=r"\.mp4"):
        set_selected(project.id, "launch-pv", "shot-01", str(notes))


def test_gallery_asset_endpoint_allows_project_video_but_not_brief(client, isolated_data_root: Path):
    project = create_project("三国")
    root = create_production(project.id, "launch-pv", "上线宣传片")
    output = root / "shots" / "shot-01" / "v1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")
    (output.parent / "notes.md").write_text("private notes", encoding="utf-8")

    video = client.get(f"/api/gallery/image?path={output.relative_to(isolated_data_root).as_posix()}")
    brief = client.get(f"/api/gallery/image?path={root.relative_to(isolated_data_root).as_posix()}/brief.md")
    notes = client.get(
        f"/api/gallery/image?path={output.parent.relative_to(isolated_data_root).as_posix()}/notes.md"
    )

    assert video.status_code == 200
    assert brief.status_code == 400
    assert notes.status_code == 400
