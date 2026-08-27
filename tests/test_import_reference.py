import json
from pathlib import Path

from character_workflow import __main__ as cli
from character_workflow.lib.jobs import list_jobs
from character_workflow.lib.schemas import AssetSlot, JobStatus


def _make_character(root: Path, character_id: str = "hero") -> Path:
    char_dir = root / "characters" / character_id
    char_dir.mkdir(parents=True)
    (char_dir / "spec.md").write_text("# Hero\n", encoding="utf-8")
    return char_dir


def test_import_reference_backs_up_source_and_registers_turnaround(
    isolated_data_root: Path, capsys,
):
    char_dir = _make_character(isolated_data_root)
    incoming = isolated_data_root / "incoming" / "hero-sheet.png"
    incoming.parent.mkdir()
    incoming.write_bytes(b"fake-png-reference")

    rc = cli.main([
        "import-reference",
        "--character", "hero",
        "--slot", "turnaround",
        "--path", str(incoming),
    ])

    assert rc == 0
    result = json.loads(capsys.readouterr().out)
    source_path = isolated_data_root / result["source_path"]
    slot_path = isolated_data_root / result["slot_path"]
    assert source_path.parent == char_dir / "source"
    assert slot_path.parent == char_dir / "turnaround"
    assert source_path.read_bytes() == incoming.read_bytes()
    assert slot_path.read_bytes() == incoming.read_bytes()
    jobs = list_jobs()
    assert len(jobs) == 1
    assert jobs[0].job_id == result["job_id"]
    assert jobs[0].status == JobStatus.DONE
    assert jobs[0].asset_slot == AssetSlot.TURNAROUND
    assert jobs[0].output_paths == [result["slot_path"]]
    assert jobs[0].source_image == str(source_path.resolve())
    assert not (char_dir / "portrait").exists()
    assert not (char_dir / "canonical.json").exists()


def test_import_reference_is_idempotent(isolated_data_root: Path, capsys):
    _make_character(isolated_data_root)
    incoming = isolated_data_root / "hero.png"
    incoming.write_bytes(b"same-image")
    args = [
        "import-reference",
        "--character", "hero",
        "--slot", "portrait",
        "--path", str(incoming),
    ]

    assert cli.main(args) == 0
    first = json.loads(capsys.readouterr().out)
    assert cli.main(args) == 0
    second = json.loads(capsys.readouterr().out)

    assert second == first
    assert len(list((isolated_data_root / "characters" / "hero" / "source").iterdir())) == 1
    assert len(list((isolated_data_root / "characters" / "hero" / "portrait").iterdir())) == 1
    assert len(list_jobs()) == 1


def test_import_reference_rejects_missing_character(isolated_data_root: Path, capsys):
    incoming = isolated_data_root / "hero.png"
    incoming.write_bytes(b"image")

    rc = cli.main([
        "import-reference",
        "--character", "missing",
        "--slot", "portrait",
        "--path", str(incoming),
    ])

    assert rc == 2
    assert "角色目录不存在" in capsys.readouterr().err


def test_import_output_copies_next_version_and_registers_done_job(
    isolated_data_root: Path, capsys,
):
    char_dir = _make_character(isolated_data_root)
    (char_dir / "portrait").mkdir()
    (char_dir / "portrait" / "v2.jpg").write_bytes(b"older")
    incoming = isolated_data_root / "lovart.png"
    incoming.write_bytes(b"generated-image")
    prompt = isolated_data_root / "prompt.md"
    prompt.write_text("保持角色轮廓，修正背鳍。", encoding="utf-8")

    rc = cli.main([
        "import-output",
        "--character", "hero",
        "--slot", "portrait",
        "--path", str(incoming),
        "--model", "Lovart · GPT Image 2 Medium",
        "--prompt-file", str(prompt),
        "--reference-image", str(incoming),
    ])

    assert rc == 0
    result = json.loads(capsys.readouterr().out)
    output = isolated_data_root / result["slot_path"]
    assert output == char_dir / "portrait" / "v3.png"
    assert output.read_bytes() == incoming.read_bytes()
    jobs = list_jobs()
    assert len(jobs) == 1
    assert jobs[0].status == JobStatus.DONE
    assert jobs[0].output_paths == [result["slot_path"]]
    assert jobs[0].model == "Lovart · GPT Image 2 Medium"
    assert jobs[0].prompt == "保持角色轮廓，修正背鳍。"
    assert not (char_dir / "canonical.json").exists()

    assert cli.main([
        "import-output",
        "--character", "hero",
        "--slot", "portrait",
        "--path", str(incoming),
    ]) == 0
    repeated = json.loads(capsys.readouterr().out)
    assert repeated["job_id"] == result["job_id"]
    assert repeated["slot_path"] == result["slot_path"]
    assert repeated["reused"] is True
    assert sorted(path.name for path in output.parent.iterdir()) == ["v2.jpg", "v3.png"]
    assert len(list_jobs()) == 1


def test_import_output_registers_existing_version_in_place(
    isolated_data_root: Path, capsys,
):
    char_dir = _make_character(isolated_data_root)
    output = char_dir / "portrait" / "v1.png"
    output.parent.mkdir()
    output.write_bytes(b"already-archived")
    args = [
        "import-output",
        "--character", "hero",
        "--slot", "portrait",
        "--path", str(output),
    ]

    assert cli.main(args) == 0
    first = json.loads(capsys.readouterr().out)
    assert cli.main(args) == 0
    second = json.loads(capsys.readouterr().out)

    assert first["slot_path"] == "characters/hero/portrait/v1.png"
    assert second["slot_path"] == first["slot_path"]
    assert second["job_id"] == first["job_id"]
    assert second["reused"] is True
    assert sorted(path.name for path in output.parent.iterdir()) == ["v1.png"]
    assert len(list_jobs()) == 1
