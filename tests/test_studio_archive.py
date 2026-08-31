from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.jobs import read_job, save_job
from character_workflow.lib.projects import assign_character, create_project
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
from character_workflow.lib.video_jobs import create_production
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root: Path) -> TestClient:
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _seed_project(root: Path):
    project = create_project("三国", slug="sanguo")
    character = root / "characters" / "cao-cao"
    character.mkdir(parents=True)
    (character / "spec.md").write_text("# 曹操\n", encoding="utf-8")
    assign_character("cao-cao", project.id)

    screens = root / "projects" / project.slug / "ui" / "v1" / "screens"
    (screens / "screen-map.md").write_text(
        "| screen-id | 名称 | 分类 | 优先级 | 状态 | 依赖 |\n"
        "|---|---|---|---|---|---|\n"
        "| home | 主界面 | core | must-have | planned | |\n",
        encoding="utf-8",
    )

    production = create_production(project.id, "launch-pv", "上线宣传片", "promo")
    (production / "prompt.md").write_text("镜头1：角色亮相。", encoding="utf-8")
    return project


def _seed_studio_job(root: Path, *, job_id: str, kind: JobKind) -> Path:
    suffix = ".png" if kind is JobKind.IMAGE else ".mp4"
    source = root / "studio" / job_id / f"v1{suffix}"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"studio-output")
    save_job(Job(
        job_id=job_id,
        character_id="default",
        prompt="自由试验提示词",
        submitted_at="2026-08-21T10:00:00Z",
        completed_at="2026-08-21T10:00:10Z",
        model="test-model",
        params=JobParams(ratio="16:9"),
        output_paths=[str(source.resolve())],
        status=JobStatus.DONE,
        error=None,
        kind=kind,
        namespace="studio",
        alias="default",
        provider="custom",
    ))
    return source


def _archive(client: TestClient, job_id: str, project_id: str, source: Path, target: dict):
    return client.post(f"/api/studio/jobs/{job_id}/archive", json={
        "source_path": str(source.resolve()),
        "project_id": project_id,
        "target": target,
    })


def test_archive_targets_follow_media_kind_and_project_ownership(client, isolated_data_root):
    project = _seed_project(isolated_data_root)

    image = client.get(
        f"/api/projects/{project.id}/studio-archive-targets",
        params={"media_kind": "image"},
    )
    video = client.get(
        f"/api/projects/{project.id}/studio-archive-targets",
        params={"media_kind": "video"},
    )

    assert image.status_code == 200
    assert [(item["kind"], item["label"]) for item in image.json()["targets"]] == [
        ("character", "曹操 · 立绘"),
        ("character", "曹操 · 美宣"),
        ("character", "曹操 · 三视图"),
        ("ui", "V1 · 主界面"),
    ]
    assert [(item["kind"], item["label"]) for item in video.json()["targets"]] == [
        ("video", "上线宣传片"),
    ]


def test_archive_image_copies_to_character_and_creates_provenance_job(
    client,
    isolated_data_root,
):
    project = _seed_project(isolated_data_root)
    source = _seed_studio_job(isolated_data_root, job_id="studio-image", kind=JobKind.IMAGE)

    response = _archive(client, "studio-image", project.id, source, {
        "kind": "character",
        "character_id": "cao-cao",
        "asset_slot": "portrait",
    })

    assert response.status_code == 201, response.text
    payload = response.json()
    target = isolated_data_root / "characters" / "cao-cao" / "portrait" / "v1.png"
    assert target.read_bytes() == b"studio-output"
    assert source.is_file()
    archived = read_job(payload["job"]["job_id"])
    assert archived.namespace == "character"
    assert archived.character_id == "cao-cao"
    assert archived.output_paths == [str(target.resolve())]
    assert archived.prompt == "自由试验提示词"
    assert archived.params.archived_from_job_id == "studio-image"
    assert archived.params.archived_from_path == str(source.resolve())
    assert read_job("studio-image").output_paths == [str(source.resolve())]


def test_archive_uses_next_version_and_rejects_wrong_source_or_media(
    client,
    isolated_data_root,
):
    project = _seed_project(isolated_data_root)
    source = _seed_studio_job(isolated_data_root, job_id="studio-image", kind=JobKind.IMAGE)
    existing = isolated_data_root / "projects" / "sanguo" / "ui" / "v1" / "screens" / "home" / "v1.png"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"existing")
    (existing.parent / "v3.webp").write_bytes(b"existing-other-format")
    target = {"kind": "ui", "ui_scheme_id": "v1", "screen_id": "home"}

    response = _archive(client, "studio-image", project.id, source, target)
    assert response.status_code == 201, response.text
    assert (existing.parent / "v4.png").read_bytes() == b"studio-output"
    archived = read_job(response.json()["job"]["job_id"])
    assert archived.character_id == ""

    wrong_path = _archive(client, "studio-image", project.id, source.parent / "other.png", target)
    assert wrong_path.status_code == 400
    assert "不属于这条 Studio 记录" in wrong_path.json()["detail"]

    wrong_media = _archive(client, "studio-image", project.id, source, {
        "kind": "video",
        "production_id": "launch-pv",
    })
    assert wrong_media.status_code == 400
    assert "图片不能归档到视频企划" in wrong_media.json()["detail"]


def test_archive_rejects_done_studio_job_whose_output_is_outside_own_directory(
    client,
    isolated_data_root,
):
    project = _seed_project(isolated_data_root)
    source = isolated_data_root / "studio" / "another-job" / "v1.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"studio-output")
    save_job(Job(
        job_id="studio-dirty",
        character_id="default",
        prompt="脏记录",
        submitted_at="2026-08-21T10:00:00Z",
        completed_at="2026-08-21T10:00:10Z",
        model="test-model",
        params=JobParams(),
        output_paths=[str(source.resolve())],
        status=JobStatus.DONE,
        error=None,
        kind=JobKind.IMAGE,
        namespace="studio",
    ))

    response = _archive(client, "studio-dirty", project.id, source, {
        "kind": "character",
        "character_id": "cao-cao",
        "asset_slot": "portrait",
    })

    assert response.status_code == 400
    assert "不在自己的输出目录" in response.json()["detail"]


def test_archive_video_copies_to_project_versions(client, isolated_data_root):
    project = _seed_project(isolated_data_root)
    source = _seed_studio_job(isolated_data_root, job_id="studio-video", kind=JobKind.VIDEO)

    response = _archive(client, "studio-video", project.id, source, {
        "kind": "video",
        "production_id": "launch-pv",
    })

    assert response.status_code == 201, response.text
    target = isolated_data_root / "projects/sanguo/videos/launch-pv/versions/v1.mp4"
    assert target.read_bytes() == b"studio-output"
    archived = read_job(response.json()["job"]["job_id"])
    assert archived.namespace == "video"
    assert archived.project_id == project.id
    assert archived.production_id == "launch-pv"
    assert archived.kind is JobKind.VIDEO
    assert archived.character_id == ""
