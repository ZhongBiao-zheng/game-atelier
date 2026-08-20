from pathlib import Path

from fastapi.testclient import TestClient

from character_workflow.lib import canonical
from character_workflow.lib.active_character import read_active, write_active
from character_workflow.lib.character_variants import read_character_variant
from character_workflow.lib.draft_processor import process_drafts
from character_workflow.lib.context_loader import load_character_context
from character_workflow.lib.jobs import job_output_dir_for, write_job
from character_workflow.lib.identity import rename_character_id
from character_workflow.lib.project_folders import (
    add_folder_item,
    create_folder,
    read_project_folders,
)
from character_workflow.lib.projects import assign_character, create_project, read_projects
from character_workflow.lib.schemas import AssetSlot, CharacterVariantCreate, ProjectFolderItem
from character_workflow.lib.turn_start import turn_start
from viewer_server.server_app import build_app


def _client(root: Path) -> TestClient:
    return TestClient(build_app(dist_dir=root / "dist"))


def _parent(root: Path):
    project = create_project("麻将游戏")
    project_dir = root / "projects" / project.slug
    (project_dir / "style.md").write_text("半写实国风，暖金与墨黑", encoding="utf-8")
    parent_id = "cao-cao"
    parent_dir = root / "characters" / parent_id
    parent_dir.mkdir(parents=True)
    (parent_dir / "spec.md").write_text(
        "---\nname: 曹操\n---\n\n## 角色定位\n- 魏国主公\n\n"
        "## 已确定要点\n- 黑狐耳、金瞳、墨色长袍\n",
        encoding="utf-8",
    )
    assign_character(parent_id, project.id)
    return project, parent_id, parent_dir


def test_variant_create_contract_rejects_blank_fields():
    assert CharacterVariantCreate(name=" 夏日皮肤 ", difference=" 浅色夏装 ").model_dump() == {
        "name": "夏日皮肤",
        "difference": "浅色夏装",
        "folder_id": None,
    }
    for payload in (
        {"name": " ", "difference": "浅色夏装"},
        {"name": "夏日皮肤", "difference": " "},
    ):
        try:
            CharacterVariantCreate(**payload)
        except ValueError:
            pass
        else:
            raise AssertionError("blank variant fields must be rejected")


def test_create_variant_from_folder_owns_independent_asset(
    isolated_data_root: Path,
):
    project, parent_id, parent_dir = _parent(isolated_data_root)
    folder = create_folder(project.id, "夏日版本").folders[0]
    client = _client(isolated_data_root)

    response = client.post(f"/api/characters/{parent_id}/variants", json={
        "name": "曹操·海滨谋略",
        "difference": "亚麻夏装，青绿色披肩，保留黑狐耳与金瞳",
        "folder_id": folder.id,
    })

    assert response.status_code == 200, response.text
    entry = response.json()
    variant_id = entry["id"]
    assert entry["variant"]["parent_character_id"] == parent_id
    assert entry["variant"]["difference"] == "亚麻夏装，青绿色披肩，保留黑狐耳与金瞳"

    variant_dir = isolated_data_root / "characters" / variant_id
    assert variant_dir != parent_dir
    assert read_character_variant(variant_id).parent_character_id == parent_id
    for slot in ("portrait", "promo", "turnaround", "source"):
        assert (variant_dir / slot).is_dir()
    variant_spec = (variant_dir / "spec.md").read_text(encoding="utf-8")
    assert "曹操·海滨谋略" in variant_spec
    assert parent_id not in variant_spec
    assert not (parent_dir / "variant.json").exists()

    assert read_projects().assignments[variant_id] == project.id
    assert read_active().active_id == variant_id
    assert read_project_folders(project.id).folders[0].items[0].model_dump() == {
        "kind": "character",
        "asset_id": variant_id,
    }


def test_variant_list_and_generation_context_include_parent_style_and_slot(
    isolated_data_root: Path,
):
    project, parent_id, _ = _parent(isolated_data_root)
    client = _client(isolated_data_root)
    created = client.post(f"/api/characters/{parent_id}/variants", json={
        "name": "曹操·夏日",
        "difference": "白色短袍与海浪纹腰带",
    }).json()
    variant_id = created["id"]

    listed = client.get("/api/characters").json()
    listed_variant = next(item for item in listed if item["id"] == variant_id)
    assert listed_variant["variant"]["parent_character_id"] == parent_id

    context = load_character_context(variant_id, "promo")
    assert context["project_style"] == "半写实国风，暖金与墨黑"
    assert "黑狐耳、金瞳、墨色长袍" in context["parent_identity_anchor"]
    assert context["variant_difference"] == "白色短袍与海浪纹腰带"
    assert context["asset_slot"] == "promo"

    write_active(variant_id)
    started = turn_start(kind="turnaround")
    assert started["project_id"] == project.id
    assert started["project_style"] == "半写实国风，暖金与墨黑"
    assert started["variant"] == {
        "parent_character_id": parent_id,
        "parent_name": "曹操",
        "parent_identity_anchor": context["parent_identity_anchor"],
        "difference": "白色短袍与海浪纹腰带",
        "asset_slot": "turnaround",
        "parent_canonical": {"portrait": None, "promo": None, "turnaround": None},
    }


def test_variant_jobs_write_only_to_variant_directory(isolated_data_root: Path):
    _, parent_id, parent_dir = _parent(isolated_data_root)
    client = _client(isolated_data_root)
    variant_id = client.post(f"/api/characters/{parent_id}/variants", json={
        "name": "曹操·夏日",
        "difference": "白色短袍",
    }).json()["id"]

    job = write_job(
        job_id="job-variant",
        character_id=variant_id,
        prompt="夏日皮肤立绘",
        model="gpt-image-2",
        params={},
        asset_slot=AssetSlot.PORTRAIT,
    )

    assert job_output_dir_for(job) == isolated_data_root / "characters" / variant_id / "portrait"
    assert job_output_dir_for(job) != parent_dir / "portrait"


def test_variant_canonical_and_feedback_stay_on_variant_asset(isolated_data_root: Path):
    _, parent_id, parent_dir = _parent(isolated_data_root)
    client = _client(isolated_data_root)
    variant_id = client.post(f"/api/characters/{parent_id}/variants", json={
        "name": "曹操·夏日",
        "difference": "白色短袍",
    }).json()["id"]
    variant_dir = isolated_data_root / "characters" / variant_id
    portrait = variant_dir / "portrait" / "v1.png"
    portrait.write_bytes(b"variant")

    response = client.post(f"/api/characters/{variant_id}/canonical", json={
        "slot": "portrait",
        "path": f"characters/{variant_id}/portrait/v1.png",
    })
    assert response.status_code == 200, response.text
    assert canonical.read_canonical(variant_id).portrait.path.endswith("/portrait/v1.png")
    assert canonical.read_canonical(parent_id).portrait is None
    assert not (parent_dir / "canonical.json").exists()

    response = client.post("/api/feedback", json={
        "text": "夏装领口更轻一些",
        "character_id": variant_id,
    })
    assert response.status_code == 200
    draft = next((isolated_data_root / ".runtime" / "draft").glob("*.md"))
    assert f"<!-- character: {variant_id} -->" in draft.read_text(encoding="utf-8")


def test_variant_requires_project_owned_parent_and_current_project_folder(
    isolated_data_root: Path,
):
    client = _client(isolated_data_root)
    orphan = isolated_data_root / "characters" / "orphan"
    orphan.mkdir(parents=True)
    (orphan / "spec.md").write_text("# 无归属角色\n", encoding="utf-8")
    response = client.post("/api/characters/orphan/variants", json={
        "name": "孤儿皮肤",
        "difference": "新服装",
    })
    assert response.status_code == 400
    assert "归属项目" in response.json()["detail"]

    project, parent_id, _ = _parent(isolated_data_root)
    other = create_project("其他项目")
    other_folder = create_folder(other.id, "其他文件夹").folders[0]
    response = client.post(f"/api/characters/{parent_id}/variants", json={
        "name": "错误皮肤",
        "difference": "不应创建",
        "folder_id": other_folder.id,
    })
    assert response.status_code == 404
    assert not any(
        item["name"] == "错误皮肤" for item in client.get("/api/characters").json()
    )
    assert read_projects().assignments[parent_id] == project.id


def test_variant_cannot_move_projects_without_parent_family(isolated_data_root: Path):
    project, parent_id, _ = _parent(isolated_data_root)
    folder = create_folder(project.id, "夏日版本").folders[0]
    other = create_project("其他项目")
    client = _client(isolated_data_root)
    variant_id = client.post(f"/api/characters/{parent_id}/variants", json={
        "name": "曹操·夏日",
        "difference": "白色短袍",
        "folder_id": folder.id,
    }).json()["id"]

    response = client.post(f"/api/characters/{variant_id}/project", json={
        "project_id": other.id,
    })
    assert response.status_code == 400
    assert read_projects().assignments[variant_id] == project.id

    response = client.post(f"/api/characters/{parent_id}/project", json={
        "project_id": "missing-project",
    })
    assert response.status_code == 404
    assert any(
        item.asset_id == variant_id
        for saved_folder in read_project_folders(project.id).folders
        for item in saved_folder.items
    )

    response = client.post(f"/api/characters/{parent_id}/project", json={
        "project_id": other.id,
    })
    assert response.status_code == 200
    assert response.json()["assignments"][parent_id] == other.id
    assert response.json()["assignments"][variant_id] == other.id
    assert all(
        item.asset_id != variant_id
        for saved_folder in read_project_folders(project.id).folders
        for item in saved_folder.items
    )


def test_plain_character_move_cleans_old_folder_reference(isolated_data_root: Path):
    project, parent_id, _ = _parent(isolated_data_root)
    folder = create_folder(project.id, "角色整理").folders[0]
    add_folder_item(
        project.id,
        folder.id,
        ProjectFolderItem(kind="character", asset_id=parent_id),
    )
    other = create_project("其他项目")
    response = _client(isolated_data_root).post(
        f"/api/characters/{parent_id}/project",
        json={"project_id": other.id},
    )
    assert response.status_code == 200
    assert all(
        item.asset_id != parent_id
        for saved_folder in read_project_folders(project.id).folders
        for item in saved_folder.items
    )


def test_variant_create_rolls_back_when_folder_link_fails(
    isolated_data_root: Path,
    monkeypatch,
):
    project, parent_id, _ = _parent(isolated_data_root)
    folder = create_folder(project.id, "夏日版本").folders[0]
    before_ids = {path.name for path in (isolated_data_root / "characters").iterdir()}
    from viewer_server import routes as routes_module

    def fail_add(*_args, **_kwargs):
        raise RuntimeError("folder write failed")

    monkeypatch.setattr(routes_module, "add_folder_item", fail_add)
    try:
        _client(isolated_data_root).post(f"/api/characters/{parent_id}/variants", json={
            "name": "曹操·夏日",
            "difference": "白色短袍",
            "folder_id": folder.id,
        })
    except RuntimeError:
        pass
    else:
        raise AssertionError("folder failure should escape the test client")

    after_ids = {path.name for path in (isolated_data_root / "characters").iterdir()}
    assert after_ids == before_ids
    assert set(read_projects().assignments) == {parent_id}


def test_variant_relationship_survives_id_normalization_and_cleans_up_on_delete(
    isolated_data_root: Path,
):
    project, parent_id, _ = _parent(isolated_data_root)
    first = create_folder(project.id, "夏日版本").folders[0]
    second = create_folder(project.id, "营销版本").folders[0]
    client = _client(isolated_data_root)
    created = client.post(f"/api/characters/{parent_id}/variants", json={
        "name": "曹操·夏日",
        "difference": "白色短袍",
        "folder_id": first.id,
    }).json()
    old_variant_id = created["id"]
    add_folder_item(
        project.id,
        second.id,
        ProjectFolderItem(kind="character", asset_id=old_variant_id),
    )
    client.post("/api/feedback", json={
        "text": "夏装领口更轻一些",
        "character_id": old_variant_id,
    })

    rename_character_id(old_variant_id, "cao-cao-summer")
    rewritten_feedback = process_drafts("cao-cao-summer")
    assert len(rewritten_feedback) == 1
    assert "夏装领口更轻一些" in rewritten_feedback[0]["content"]
    folder_items = [
        item.asset_id
        for folder in read_project_folders(project.id).folders
        for item in folder.items
    ]
    assert folder_items.count("cao-cao-summer") == 2
    assert old_variant_id not in folder_items

    rename_character_id(parent_id, "cao-cao-renamed")
    assert read_character_variant("cao-cao-summer").parent_character_id == "cao-cao-renamed"

    blocked = client.delete("/api/characters/cao-cao-renamed")
    assert blocked.status_code == 409
    assert "1 个皮肤" in blocked.json()["detail"]

    deleted = client.delete("/api/characters/cao-cao-summer")
    assert deleted.status_code == 200
    assert all(
        item.asset_id != "cao-cao-summer"
        for folder in read_project_folders(project.id).folders
        for item in folder.items
    )
