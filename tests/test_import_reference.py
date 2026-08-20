import json
from pathlib import Path

from character_workflow import __main__ as cli


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
