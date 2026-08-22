from pathlib import Path

from fastapi.testclient import TestClient

from character_workflow.lib import canonical
from character_workflow.lib.active_character import read_active, write_active
from character_workflow.lib.character_derivatives import read_character_derivative
from character_workflow.lib.context_loader import load_character_context
from character_workflow.lib.identity import rename_character_id
from character_workflow.lib.jobs import job_output_dir_for, write_job
from character_workflow.lib.projects import assign_character, create_project, read_projects
from character_workflow.lib.schemas import AssetSlot, CharacterDerivativeCreate
from character_workflow.lib.turn_start import turn_start
from viewer_server.server_app import build_app


def _client(root: Path) -> TestClient:
    return TestClient(build_app(dist_dir=root / "dist"))


def _source_character(root: Path):
    project = create_project("麻将游戏")
    project_dir = root / "projects" / project.slug
    (project_dir / "style.md").write_text("半写实国风，暖金与墨黑", encoding="utf-8")
    character_id = "cao-cao"
    character_dir = root / "characters" / character_id
    character_dir.mkdir(parents=True)
    for slot in ("portrait", "promo", "turnaround", "source"):
        (character_dir / slot).mkdir()
    (character_dir / "spec.md").write_text("# 曹操\n\n黑狐耳、金瞳、墨色长袍\n", encoding="utf-8")
    portrait = character_dir / "portrait" / "v1.png"
    portrait.write_bytes(b"canonical portrait")
    canonical.set_canonical(character_id, AssetSlot.PORTRAIT, str(portrait))
    assign_character(character_id, project.id)
    return project, character_id, character_dir


def test_derivative_create_contract_only_requires_name():
    assert CharacterDerivativeCreate(name=" 曹操·夏日 ").model_dump() == {
        "name": "曹操·夏日",
        "source_paths": [],
    }
    try:
        CharacterDerivativeCreate(name=" ")
    except ValueError:
        pass
    else:
        raise AssertionError("blank derivative name must be rejected")


def test_create_derivative_freezes_canonical_and_uploaded_sources(isolated_data_root: Path):
    project, source_id, source_dir = _source_character(isolated_data_root)
    upload = isolated_data_root / ".runtime" / "uploads" / "mood.jpg"
    upload.parent.mkdir(parents=True)
    upload.write_bytes(b"uploaded mood")

    response = _client(isolated_data_root).post(
        f"/api/characters/{source_id}/derivatives",
        json={"name": "曹操·海滨谋略", "source_paths": [str(upload)]},
    )

    assert response.status_code == 200, response.text
    entry = response.json()
    derivative_id = entry["id"]
    relation = entry["derivative"]
    assert relation["source_character_id"] == source_id
    assert relation["source_character_name"] == "曹操"
    assert len(relation["source_paths"]) == 2

    derivative_dir = isolated_data_root / "characters" / derivative_id
    assert derivative_dir != source_dir
    copied = [isolated_data_root / path for path in relation["source_paths"]]
    assert [path.read_bytes() for path in copied] == [b"canonical portrait", b"uploaded mood"]
    assert read_character_derivative(derivative_id).source_paths == relation["source_paths"]
    assert not (derivative_dir / "variant.json").exists()
    assert read_projects().assignments[derivative_id] == project.id
    assert read_active().active_id == derivative_id


def test_derivative_context_uses_frozen_sources_and_project_style(isolated_data_root: Path):
    project, source_id, _ = _source_character(isolated_data_root)
    client = _client(isolated_data_root)
    created = client.post(
        f"/api/characters/{source_id}/derivatives",
        json={"name": "曹操·夏日"},
    ).json()
    derivative_id = created["id"]

    listed = client.get("/api/characters").json()
    listed_derivative = next(item for item in listed if item["id"] == derivative_id)
    assert listed_derivative["derivative"]["source_character_id"] == source_id

    context = load_character_context(derivative_id, "promo")
    assert context["project_style"] == "半写实国风，暖金与墨黑"
    assert context["derivative_source_paths"] == created["derivative"]["source_paths"]
    assert context["asset_slot"] == "promo"

    write_active(derivative_id)
    started = turn_start(kind="turnaround")
    assert started["project_id"] == project.id
    assert started["derivative"] == {
        "source_character_id": source_id,
        "source_character_name": "曹操",
        "source_paths": created["derivative"]["source_paths"],
        "asset_slot": "turnaround",
    }


def test_derivative_is_a_fully_independent_character_asset(isolated_data_root: Path):
    _, source_id, source_dir = _source_character(isolated_data_root)
    client = _client(isolated_data_root)
    derivative_id = client.post(
        f"/api/characters/{source_id}/derivatives",
        json={"name": "曹操·夏日"},
    ).json()["id"]

    job = write_job(
        job_id="job-derivative",
        character_id=derivative_id,
        prompt="夏日角色立绘",
        model="gpt-image-2",
        params={},
        asset_slot=AssetSlot.PORTRAIT,
    )
    assert job_output_dir_for(job) == isolated_data_root / "characters" / derivative_id / "portrait"
    assert job_output_dir_for(job) != source_dir / "portrait"

    derivative_portrait = isolated_data_root / "characters" / derivative_id / "portrait" / "v1.png"
    derivative_portrait.write_bytes(b"derivative")
    response = client.post(f"/api/characters/{derivative_id}/canonical", json={
        "slot": "portrait",
        "path": f"characters/{derivative_id}/portrait/v1.png",
    })
    assert response.status_code == 200
    assert canonical.read_canonical(derivative_id).portrait.path.endswith("/portrait/v1.png")
    assert canonical.read_canonical(source_id).portrait.path.endswith("/portrait/v1.png")


def test_derivative_can_move_delete_and_be_used_as_a_new_source(isolated_data_root: Path):
    project, source_id, _ = _source_character(isolated_data_root)
    other = create_project("其他项目")
    client = _client(isolated_data_root)
    first = client.post(
        f"/api/characters/{source_id}/derivatives",
        json={"name": "曹操·夏日"},
    ).json()
    first_id = first["id"]

    nested = client.post(
        f"/api/characters/{first_id}/derivatives",
        json={"name": "海滨宣传版本"},
    )
    assert nested.status_code == 200, nested.text
    nested_id = nested.json()["id"]
    assert read_projects().assignments[nested_id] == project.id

    moved = client.post(
        f"/api/characters/{first_id}/project",
        json={"project_id": other.id},
    )
    assert moved.status_code == 200
    assert moved.json()["assignments"][first_id] == other.id
    assert moved.json()["assignments"][nested_id] == project.id

    deleted_source = client.delete(f"/api/characters/{source_id}")
    assert deleted_source.status_code == 200
    assert read_character_derivative(first_id).source_character_name == "曹操"
    assert all((isolated_data_root / path).is_file() for path in first["derivative"]["source_paths"])


def test_derivative_rejects_cross_project_and_non_image_sources(isolated_data_root: Path):
    _, source_id, _ = _source_character(isolated_data_root)
    other = create_project("其他项目")
    other_id = "other-role"
    other_dir = isolated_data_root / "characters" / other_id
    other_dir.mkdir(parents=True)
    (other_dir / "spec.md").write_text("# 其他角色\n", encoding="utf-8")
    foreign = other_dir / "portrait" / "v1.png"
    foreign.parent.mkdir()
    foreign.write_bytes(b"foreign")
    assign_character(other_id, other.id)
    video = isolated_data_root / ".runtime" / "uploads" / "clip.mp4"
    video.parent.mkdir(parents=True)
    video.write_bytes(b"video")
    client = _client(isolated_data_root)

    cross_project = client.post(f"/api/characters/{source_id}/derivatives", json={
        "name": "错误来源",
        "source_paths": [str(foreign)],
    })
    assert cross_project.status_code == 400
    assert "当前项目" in cross_project.json()["detail"]

    wrong_type = client.post(f"/api/characters/{source_id}/derivatives", json={
        "name": "错误格式",
        "source_paths": [str(video)],
    })
    assert wrong_type.status_code == 400
    assert "来源图片" in wrong_type.json()["detail"]


def test_renaming_does_not_mutate_derivative_source_snapshot(isolated_data_root: Path):
    _, source_id, _ = _source_character(isolated_data_root)
    client = _client(isolated_data_root)
    derivative_id = client.post(
        f"/api/characters/{source_id}/derivatives",
        json={"name": "曹操·夏日"},
    ).json()["id"]

    rename_character_id(source_id, "cao-cao-renamed")
    relation = read_character_derivative(derivative_id)
    assert relation.source_character_id == source_id
    assert relation.source_character_name == "曹操"
