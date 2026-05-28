import json
from pathlib import Path


def _write_project(root: Path) -> None:
    runtime = root / ".runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "projects.json").write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "id": "p-1",
                        "slug": "ma-jiang-you-xi",
                        "name": "麻将游戏",
                        "created_at": "2026-05-28T00:00:00+00:00",
                    }
                ],
                "assignments": {"char-1779692464": "p-1"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def test_lists_web_created_temp_characters_with_assets(isolated_data_root):
    root = isolated_data_root
    _write_project(root)
    char = root / "characters" / "char-1779692464"
    for sub in ("portrait", "promo", "turnaround", "source"):
        (char / sub).mkdir(parents=True, exist_ok=True)
    (char / "spec.md").write_text(
        "# 孙尚香\n\n（尚无档案 — 请在终端 /character-workflow 对话补全）\n",
        encoding="utf-8",
    )
    (char / "source" / "ref.png").write_bytes(b"png")
    (char / "portrait" / "v1.png").write_bytes(b"png")

    jobs = root / ".runtime" / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    (jobs / "job-1.json").write_text(
        json.dumps(
            {
                "job_id": "job-1",
                "character_id": "char-1779692464",
                "prompt": "手动上传",
                "submitted_at": "2026-05-28T00:00:00+00:00",
                "model": "manual",
                "params": {},
                "seed": None,
                "output_paths": [str((char / "portrait" / "v1.png").resolve())],
                "status": "done",
                "error": None,
                "asset_slot": "portrait",
                "kind": "image",
                "namespace": "character",
                "source_image": None,
                "alias": None,
                "provider": None,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    from character_workflow.lib.identity import list_pending_identity_normalizations

    pending = list_pending_identity_normalizations()

    assert [item.old_id for item in pending] == ["char-1779692464"]
    item = pending[0]
    assert item.display_name == "孙尚香"
    assert item.recommended_id == "sun-shang-xiang"
    assert item.spec_status == "placeholder"
    assert item.project_id == "p-1"
    assert item.project_name == "麻将游戏"
    assert item.asset_counts == {
        "source": 1,
        "portrait": 1,
        "promo": 0,
        "turnaround": 0,
    }
    assert item.job_count == 1
    assert item.has_assets is True


def test_rename_character_id_moves_assets_and_updates_references(isolated_data_root):
    root = isolated_data_root
    _write_project(root)
    old_id = "char-1779692464"
    new_id = "sun-shang-xiang"
    old = root / "characters" / old_id
    for sub in ("portrait", "promo", "turnaround", "source"):
        (old / sub).mkdir(parents=True, exist_ok=True)
    (old / "spec.md").write_text("# 孙尚香\n\n女性弓手\n", encoding="utf-8")
    portrait = old / "portrait" / "v1.png"
    source = old / "source" / "ref.png"
    portrait.write_bytes(b"png")
    source.write_bytes(b"png")

    runtime = root / ".runtime"
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": old_id, "updated_at": "2026-05-28T00:00:00+00:00"}),
        encoding="utf-8",
    )
    jobs = runtime / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    (jobs / "job-1.json").write_text(
        json.dumps(
            {
                "job_id": "job-1",
                "character_id": old_id,
                "prompt": "手动上传",
                "submitted_at": "2026-05-28T00:00:00+00:00",
                "model": "manual",
                "params": {
                    "reference_images": [str(source.resolve())],
                    "lovart_attachments": [str(source.resolve())],
                },
                "seed": None,
                "output_paths": [str(portrait.resolve())],
                "status": "done",
                "error": None,
                "asset_slot": "portrait",
                "kind": "image",
                "namespace": "character",
                "source_image": str(source.resolve()),
                "alias": None,
                "provider": None,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    from character_workflow.lib.identity import rename_character_id

    result = rename_character_id(old_id, new_id)

    assert result == {"old_id": old_id, "new_id": new_id, "ok": True}
    assert not old.exists()
    assert (root / "characters" / new_id / "spec.md").exists()
    assert (root / "characters" / new_id / "portrait" / "v1.png").exists()
    assert (root / "characters" / new_id / "source" / "ref.png").exists()

    active = json.loads((runtime / "active-character.json").read_text(encoding="utf-8"))
    assert active["active_id"] == new_id

    projects = json.loads((runtime / "projects.json").read_text(encoding="utf-8"))
    assert projects["assignments"] == {new_id: "p-1"}

    job = json.loads((jobs / "job-1.json").read_text(encoding="utf-8"))
    assert job["character_id"] == new_id
    assert job["output_paths"] == [
        str((root / "characters" / new_id / "portrait" / "v1.png").resolve())
    ]
    assert job["source_image"] == str(
        (root / "characters" / new_id / "source" / "ref.png").resolve()
    )
    assert job["params"]["reference_images"] == [
        str((root / "characters" / new_id / "source" / "ref.png").resolve())
    ]
    assert job["params"]["lovart_attachments"] == [
        str((root / "characters" / new_id / "source" / "ref.png").resolve())
    ]


def test_rename_character_id_rejects_existing_target(isolated_data_root):
    root = isolated_data_root
    (root / "characters" / "char-1").mkdir(parents=True)
    (root / "characters" / "char-1" / "spec.md").write_text("# A\n", encoding="utf-8")
    (root / "characters" / "sun-shang-xiang").mkdir(parents=True)

    from character_workflow.lib.identity import rename_character_id

    try:
        rename_character_id("char-1", "sun-shang-xiang")
    except FileExistsError as exc:
        assert "sun-shang-xiang" in str(exc)
    else:
        raise AssertionError("expected FileExistsError")


def test_rename_character_id_rewrites_windows_style_paths(isolated_data_root):
    root = isolated_data_root
    old_id = "char-1779692464"
    new_id = "sun-shang-xiang"
    old = root / "characters" / old_id
    old.mkdir(parents=True)
    (old / "spec.md").write_text("# 孙尚香\n", encoding="utf-8")

    jobs = root / ".runtime" / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    windows_path = r"C:\Users\me\characters\char-1779692464\portrait\v1.png"
    (jobs / "job-1.json").write_text(
        json.dumps(
            {
                "job_id": "job-1",
                "character_id": old_id,
                "prompt": "手动上传",
                "submitted_at": "2026-05-28T00:00:00+00:00",
                "model": "manual",
                "params": {"reference_images": [windows_path]},
                "seed": None,
                "output_paths": [windows_path],
                "status": "done",
                "error": None,
                "asset_slot": "portrait",
                "kind": "image",
                "namespace": "character",
                "source_image": windows_path,
                "alias": None,
                "provider": None,
            }
        ),
        encoding="utf-8",
    )

    from character_workflow.lib.identity import rename_character_id

    rename_character_id(old_id, new_id)

    job = json.loads((jobs / "job-1.json").read_text(encoding="utf-8"))
    assert job["output_paths"] == [
        r"C:\Users\me\characters\sun-shang-xiang\portrait\v1.png"
    ]
    assert job["source_image"] == r"C:\Users\me\characters\sun-shang-xiang\portrait\v1.png"
    assert job["params"]["reference_images"] == [
        r"C:\Users\me\characters\sun-shang-xiang\portrait\v1.png"
    ]


def test_rename_character_id_rewrites_relative_paths(isolated_data_root):
    root = isolated_data_root
    old_id = "char-1779358169"
    new_id = "huo-li-hu"
    old = root / "characters" / old_id
    old.mkdir(parents=True)
    (old / "spec.md").write_text("# 火栗狐\n", encoding="utf-8")

    jobs = root / ".runtime" / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    (jobs / "job-1.json").write_text(
        json.dumps(
            {
                "job_id": "job-1",
                "character_id": old_id,
                "prompt": "三视图",
                "submitted_at": "2026-05-28T00:00:00+00:00",
                "model": "manual",
                "params": {"reference_images": [f"characters/{old_id}/portrait/v1.png"]},
                "seed": None,
                "output_paths": [f"characters/{old_id}/turnaround/v1.png"],
                "status": "done",
                "error": None,
                "asset_slot": "turnaround",
                "kind": "image",
                "namespace": "character",
                "source_image": f"characters/{old_id}/portrait/v1.png",
                "alias": None,
                "provider": None,
            }
        ),
        encoding="utf-8",
    )

    from character_workflow.lib.identity import rename_character_id

    rename_character_id(old_id, new_id)

    job = json.loads((jobs / "job-1.json").read_text(encoding="utf-8"))
    assert job["output_paths"] == ["characters/huo-li-hu/turnaround/v1.png"]
    assert job["source_image"] == "characters/huo-li-hu/portrait/v1.png"
    assert job["params"]["reference_images"] == ["characters/huo-li-hu/portrait/v1.png"]


def test_rename_character_id_cli(isolated_data_root, capsys):
    root = isolated_data_root
    old = root / "characters" / "char-1779692464"
    old.mkdir(parents=True)
    (old / "spec.md").write_text("# 孙尚香\n", encoding="utf-8")

    from character_workflow.__main__ import main

    code = main(["rename-character-id", "char-1779692464", "sun-shang-xiang"])

    assert code == 0
    assert json.loads(capsys.readouterr().out) == {
        "old_id": "char-1779692464",
        "new_id": "sun-shang-xiang",
        "ok": True,
    }
    assert not old.exists()
    assert (root / "characters" / "sun-shang-xiang" / "spec.md").exists()
