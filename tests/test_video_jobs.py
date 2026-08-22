from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.__main__ import main
from character_workflow.lib import canonical, keys, ui_schemes
from character_workflow.lib.jobs import job_output_dir_for, read_job, save_job
from character_workflow.lib.projects import assign_character, create_project
from character_workflow.lib.schemas import (
    AssetSlot,
    Job,
    JobKind,
    JobParams,
    JobStatus,
    UiSchemeCreate,
)
from character_workflow.lib.ui_jobs import set_screen_canonical
from character_workflow.lib.video_jobs import (
    create_production,
    list_productions,
    list_reference_candidates,
    production_output_dir,
    read_references,
    set_references,
    set_selected,
)
from character_workflow.lib.video_caps import validate_seedance_request
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


def _seed_project_reference_assets(isolated_data_root: Path):
    project = create_project("三国", slug="sanguo")
    for character_id, name in (("cao-cao", "曹操"), ("cao-cao-summer", "曹操·夏日")):
        character_root = isolated_data_root / "characters" / character_id
        portrait = character_root / "portrait" / "v1.png"
        portrait.parent.mkdir(parents=True)
        portrait.write_bytes(b"png")
        (character_root / "spec.md").write_text(f"# {name}\n", encoding="utf-8")
        assign_character(character_id, project.id)
        canonical.set_canonical(character_id, AssetSlot.PORTRAIT, str(portrait))
    (isolated_data_root / "characters" / "cao-cao-summer" / "derivative.json").write_text(
        '{"source_character_id":"cao-cao","source_character_name":"曹操",'
        '"source_paths":[],"created_at":"2026-08-20T00:00:00Z"}',
        encoding="utf-8",
    )
    ui_schemes.create_scheme(project.id, UiSchemeCreate(name="V2"))
    ui_screen = (
        isolated_data_root / "projects" / project.slug / "ui" / "v2"
        / "screens" / "home" / "v1.png"
    )
    ui_screen.parent.mkdir(parents=True)
    ui_screen.write_bytes(b"png")
    set_screen_canonical(project.id, "v2", "home", str(ui_screen))
    create_production(project.id, "launch-pv", "上线宣传片")
    return project


def test_create_production_writes_brief_and_prompt(isolated_data_root: Path):
    project = create_project("三国")

    root = create_production(project.id, "launch-pv", "上线宣传片", "promo")

    assert root == isolated_data_root / "projects" / project.slug / "videos" / "launch-pv"
    assert 'title: "上线宣传片"' in (root / "brief.md").read_text(encoding="utf-8")
    assert (root / "prompt.md").is_file()
    assert not (root / "shot-map.md").exists()


def test_video_job_is_owned_by_production_and_outputs_complete_versions(
    isolated_data_root: Path,
):
    project = create_project("三国")
    create_production(project.id, "launch-pv", "上线宣传片")
    job = Job(
        job_id="job-video-1",
        character_id="",
        prompt="镜头1：角色亮相。\n镜头2：角色出招。",
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
    )

    assert job_output_dir_for(job) == (
        isolated_data_root / "projects" / project.slug / "videos" / "launch-pv" / "versions"
    )


def test_video_namespace_requires_project_and_production():
    with pytest.raises(ValueError, match="requires project_id and production_id"):
        Job(
            job_id="job-invalid-video",
            character_id="",
            prompt="镜头1：亮相。",
            submitted_at="2026-08-20T00:00:00Z",
            model="seedance-2.5",
            params=JobParams(),
            output_paths=[],
            status=JobStatus.PENDING_CONFIRM,
            error=None,
            kind=JobKind.VIDEO,
            namespace="video",
        )


def test_seedance_limits_are_checked_before_submission():
    base = {
        "duration": 15,
        "reference_images": [],
        "reference_videos": [],
        "reference_audios": [],
    }
    validate_seedance_request("seedance-2.0-mini", base, "镜头1：亮相。")
    validate_seedance_request("seedance-2.5", {**base, "duration": 30}, "镜头1：亮相。")
    validate_seedance_request("doubao-seedance-2-0-fast-260128", base, "镜头1：亮相。")
    validate_seedance_request(
        "doubao-seedance-2-5-260628", {**base, "duration": 30}, "镜头1：亮相。"
    )

    with pytest.raises(ValueError, match="4–15"):
        validate_seedance_request("seedance-2.0", {**base, "duration": 16}, "镜头1")
    with pytest.raises(ValueError, match="4–15"):
        validate_seedance_request("doubao-seedance-2-0-fast-260128", {
            **base,
            "duration": 16,
        }, "镜头1")
    with pytest.raises(ValueError, match="总数不能超过 12"):
        validate_seedance_request("seedance-2.0", {
            **base,
            "reference_images": [f"image-{index}" for index in range(9)],
            "reference_videos": ["video-1", "video-2", "video-3"],
            "reference_audios": ["audio-1"],
        }, "镜头1")
    with pytest.raises(ValueError, match="不能使用时间戳"):
        validate_seedance_request("seedance-2.0-mini", base, "[00:00-00:03] 角色亮相。")


def test_seedance_25_timeline_must_not_overlap_or_exceed_duration():
    params = {
        "duration": 15,
        "reference_images": [],
        "reference_videos": [],
        "reference_audios": [],
    }
    validate_seedance_request(
        "doubao-seedance-2-5-260628",
        params,
        "[00:00-00:05] 亮相。\n[00:05-00:15] 对决。",
    )
    with pytest.raises(ValueError, match="不能重叠"):
        validate_seedance_request(
            "seedance-2.5",
            params,
            "[00:00-00:06] 亮相。\n[00:05-00:10] 对决。",
        )
    with pytest.raises(ValueError, match="超过请求时长"):
        validate_seedance_request("seedance-2.5", params, "[00:10-00:16] 收尾。")


def test_reference_selection_is_production_level(isolated_data_root: Path):
    project = _seed_project_reference_assets(isolated_data_root)
    selected = [
        "characters/cao-cao-summer/portrait/v1.png",
        "projects/sanguo/ui/v2/screens/home/v1.png",
    ]

    assert set_references(project.id, "launch-pv", selected) == selected
    assert read_references(project.id, "launch-pv") == selected
    assert [item.kind for item in list_reference_candidates(project.id)] == [
        "character", "character", "ui_screen",
    ]

    with pytest.raises(ValueError, match="project asset candidate"):
        set_references(project.id, "launch-pv", ["/tmp/not-owned.png"])


def test_character_without_canonical_uses_initial_portrait(isolated_data_root: Path):
    project = create_project("三国")
    character_root = isolated_data_root / "characters" / "sun-ce"
    portrait = character_root / "portrait" / "v1.png"
    portrait.parent.mkdir(parents=True)
    portrait.write_bytes(b"png")
    (character_root / "spec.md").write_text("# 孙策\n", encoding="utf-8")
    assign_character("sun-ce", project.id)

    candidates = list_reference_candidates(project.id)

    assert [(item.path, item.detail) for item in candidates] == [
        ("characters/sun-ce/portrait/v1.png", "角色初始图（尚未定稿）")
    ]


def test_submit_video_production_creates_one_job_for_multi_shot_prompt(
    isolated_data_root: Path,
    capsys,
):
    project = _seed_project_reference_assets(isolated_data_root)
    _seed_video_key()
    references = ["characters/cao-cao-summer/portrait/v1.png"]
    set_references(project.id, "launch-pv", references)
    prompt = production_output_dir(project.id, "launch-pv").parent / "prompt.md"
    prompt.write_text(
        "主体：曹操@图片1。\n\n镜头1：曹操奔跑。\n镜头2：曹操回头。\n镜头3：定格。",
        encoding="utf-8",
    )

    assert main([
        "submit-video-production",
        "--project", project.id,
        "--production", "launch-pv",
        "--duration", "15",
        "--ratio", "9:16",
    ]) == 0
    captured = capsys.readouterr()
    job = read_job(captured.out.strip())

    assert job.production_id == "launch-pv"
    assert job.params.duration == 15
    assert job.params.ratio == "9:16"
    assert job.prompt.count("镜头") == 3
    assert job.params.reference_images == [
        str((isolated_data_root / references[0]).resolve())
    ]
    assert "企划   : launch-pv（项目完整视频 job）" in captured.err


def test_list_and_select_complete_video_versions(isolated_data_root: Path):
    project = create_project("三国")
    root = create_production(project.id, "launch-pv", "上线宣传片", "promo")
    (root / "prompt.md").write_text("镜头1：角色亮相。", encoding="utf-8")
    output = production_output_dir(project.id, "launch-pv") / "v1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")

    selected = set_selected(project.id, "launch-pv", str(output))
    production = list_productions(project.id)[0]
    expected = f"projects/{project.slug}/videos/launch-pv/versions/v1.mp4"

    assert selected == expected
    assert production.versions == [expected]
    assert production.selected == expected
    assert production.prompt == "镜头1：角色亮相。"


def test_missing_selected_version_is_not_reported(isolated_data_root: Path):
    project = create_project("三国", slug="sanguo")
    root = create_production(project.id, "launch-pv", "上线宣传片", "promo")
    (root / "selected.json").write_text(
        '{"path":"projects/sanguo/videos/launch-pv/versions/missing.mp4"}',
        encoding="utf-8",
    )

    assert list_productions(project.id)[0].selected is None


def test_production_history_contains_whole_video_jobs(isolated_data_root: Path):
    project = create_project("三国")
    root = create_production(project.id, "launch-pv", "上线宣传片", "promo")
    (root / "prompt.md").write_text("镜头1：亮相。\n镜头2：出招。", encoding="utf-8")
    save_job(Job(
        job_id="job-video-new",
        character_id="",
        prompt="镜头1：亮相。\n镜头2：出招。",
        submitted_at="2026-08-20T00:00:00Z",
        model="seedance-2.5-pro",
        params=JobParams(duration=15, ratio="9:16"),
        output_paths=[],
        status=JobStatus.PENDING_CONFIRM,
        error=None,
        kind=JobKind.VIDEO,
        namespace="video",
        project_id=project.id,
        production_id="launch-pv",
    ))

    production = list_productions(project.id)[0]

    assert [record.job_id for record in production.history] == ["job-video-new"]
    assert production.history[0].prompt.count("镜头") == 2
    assert production.history[0].params.duration == 15


def test_video_api_updates_production_references_and_selected_version(
    client: TestClient,
    isolated_data_root: Path,
):
    project = _seed_project_reference_assets(isolated_data_root)
    selected_references = ["characters/cao-cao-summer/portrait/v1.png"]
    output = production_output_dir(project.id, "launch-pv") / "v1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")
    relative = output.relative_to(isolated_data_root).as_posix()

    references = client.post(
        f"/api/projects/{project.id}/videos/launch-pv/references",
        json={"paths": selected_references},
    )
    selected = client.post(
        f"/api/projects/{project.id}/videos/launch-pv/selected",
        json={"path": relative},
    )
    listed = client.get(f"/api/projects/{project.id}/videos")
    detail = client.get(f"/api/projects/{project.id}/videos/launch-pv")

    assert references.json() == {"paths": selected_references}
    assert selected.json() == {"path": relative}
    assert listed.json()["productions"][0]["planned_reference_images"] == selected_references
    assert listed.json()["productions"][0]["selected"] == relative
    assert detail.status_code == 200
    assert detail.json()["production_id"] == "launch-pv"


def test_selected_version_rejects_non_mp4(isolated_data_root: Path):
    project = create_project("三国")
    create_production(project.id, "launch-pv", "上线宣传片")
    notes = production_output_dir(project.id, "launch-pv") / "notes.md"
    notes.parent.mkdir(parents=True)
    notes.write_text("not a video", encoding="utf-8")

    with pytest.raises(ValueError, match=r"\.mp4"):
        set_selected(project.id, "launch-pv", str(notes))


def test_gallery_asset_endpoint_allows_video_versions_but_not_prompt(
    client: TestClient,
    isolated_data_root: Path,
):
    project = create_project("三国")
    root = create_production(project.id, "launch-pv", "上线宣传片")
    output = root / "versions" / "v1.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"video")

    video = client.get(
        f"/api/gallery/image?path={output.relative_to(isolated_data_root).as_posix()}"
    )
    prompt = client.get(
        f"/api/gallery/image?path={root.relative_to(isolated_data_root).as_posix()}/prompt.md"
    )

    assert video.status_code == 200
    assert prompt.status_code == 400
