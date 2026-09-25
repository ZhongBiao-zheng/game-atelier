"""docs/team-library-format.md 是公开格式：示例、表格、正则必须与代码一致。"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest
from pydantic import BaseModel

from tests.test_team_library_index import scan_and_cache
from character_workflow.lib.schemas import (
    MEDIA_SUFFIXES,
    SHA256_PATTERN,
    TEAM_ASSET_ID_PATTERN,
    TEAM_LIBRARY_ID_PATTERN,
    TEAM_RECIPE_INPUT_PATH_PATTERN,
    TeamAssetFile,
    TeamLibraryManifest,
    TeamLibraryMount,
)
from character_workflow.lib.team_library import MANIFEST_NAME, read_manifest
from character_workflow.lib.team_library_index import _CONFLICT_SUFFIX, RAW_SUFFIXES
from character_workflow.lib.team_library_share import author_dir_name

DOC = Path(__file__).resolve().parents[1] / "docs" / "team-library-format.md"
_EXAMPLE = re.compile(r"<!-- example: (manifest|asset) -->\s*```json\n(.*?)\n```", re.DOTALL)
RAW_EXAMPLE_PATH = "角色/董卓/idle.png"


def _doc_text() -> str:
    return DOC.read_text(encoding="utf-8")


def _examples(label: str) -> list[dict]:
    return [json.loads(body) for kind, body in _EXAMPLE.findall(_doc_text()) if kind == label]


def placeholder_bytes(asset_id: str, slot: str) -> bytes:
    """示例文件的占位内容：slot 为 media 或 input-<order>。文档里的 sha256 / bytes 按它算。"""
    return f"team-library-format example {asset_id} {slot}\n".encode("utf-8")


def _sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def test_doc_has_manifest_and_both_asset_kinds():
    assert len(_examples("manifest")) == 1
    kinds = sorted(example["kind"] for example in _examples("asset"))
    assert kinds == ["generation", "prompt"]


def _assert_no_unknown_keys(data: dict, instance: BaseModel, where: str) -> None:
    """读模型是 extra="ignore"，字段拼错也能过校验：逐层比对示例的键与实际命中的模型字段。"""
    unknown = set(data) - set(type(instance).model_fields)
    assert not unknown, f"{where} 有模型里没有的字段：{sorted(unknown)}"
    for name, raw in data.items():
        value = getattr(instance, name)
        if isinstance(value, BaseModel):
            _assert_no_unknown_keys(raw, value, f"{where}.{name}")
        elif isinstance(value, list):
            for i, (raw_item, item) in enumerate(zip(raw, value, strict=True)):
                if isinstance(item, BaseModel):
                    _assert_no_unknown_keys(raw_item, item, f"{where}.{name}[{i}]")


def test_examples_validate_against_team_models():
    for example in _examples("manifest"):
        manifest = TeamLibraryManifest.model_validate(example)
        _assert_no_unknown_keys(example, manifest, "manifest")
    for example in _examples("asset"):
        asset = TeamAssetFile.model_validate(example)
        _assert_no_unknown_keys(example, asset, example["asset_id"])


def test_example_hashes_match_placeholder_bytes():
    for example in _examples("asset"):
        asset_id = example["asset_id"]
        if "media" in example:
            body = placeholder_bytes(asset_id, "media")
            assert example["media"]["sha256"] == _sha(body)
            assert example["media"]["bytes"] == len(body)
        for row in example.get("snapshot", {}).get("inputs", []):
            sha = _sha(placeholder_bytes(asset_id, f"input-{row['order']}"))
            assert row["sha256"] == sha
            suffix = MEDIA_SUFFIXES[row["mime_type"]]
            assert row["path"] == f"refs/{row['order'] + 1:02d}-{sha[:12]}{suffix}"


def _build_library(root: Path) -> None:
    (root / MANIFEST_NAME).write_text(
        json.dumps(_examples("manifest")[0], ensure_ascii=False), encoding="utf-8"
    )
    for example in _examples("asset"):
        asset_id = example["asset_id"]
        folder = root / "shared" / author_dir_name(example["author"]["display_name"]) / asset_id
        folder.mkdir(parents=True)
        (folder / "asset.json").write_text(
            json.dumps(example, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        if "media" in example:
            (folder / example["media"]["filename"]).write_bytes(placeholder_bytes(asset_id, "media"))
        for row in example.get("snapshot", {}).get("inputs", []):
            target = folder / row["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(placeholder_bytes(asset_id, f"input-{row['order']}"))
    raw = root / RAW_EXAMPLE_PATH
    raw.parent.mkdir(parents=True)
    raw.write_bytes(b"raw team asset")


def test_library_built_from_examples_scans_ready(tmp_path: Path):
    root = tmp_path / "library"
    root.mkdir()
    _build_library(root)
    manifest = read_manifest(root)
    mount = TeamLibraryMount(
        library_id=manifest.library_id, project_id="proj-doc", mount_path=str(root),
        name=manifest.name, mounted_at="2026-09-25T00:00:00+00:00",
    )

    index = scan_and_cache(mount)

    shared = [e for e in index.entries if e.kind != "raw"]
    raw = [e for e in index.entries if e.kind == "raw"]
    assert sorted(e.id for e in shared) == sorted(a["asset_id"] for a in _examples("asset"))
    assert all(e.status == "ready" for e in shared)
    assert [e.relative_path for e in raw] == [RAW_EXAMPLE_PATH]
    assert raw[0].status == "ready"


_TABLE_ROW = re.compile(r"^\| `([^`]+)` \| `([^`]+)` \|$")


def _table_rows(header: str) -> set[tuple[str, str]]:
    """表头行之后（跳过分隔行）连续的两列代码行，解析成集合。"""
    lines = _doc_text().splitlines()
    start = lines.index(header) + 2
    rows: set[tuple[str, str]] = set()
    for line in lines[start:]:
        match = _TABLE_ROW.match(line)
        if match is None:
            break
        rows.add((match.group(1), match.group(2)))
    return rows


def test_media_suffix_table_matches_code():
    assert _table_rows("| mime_type | 后缀 |") == set(MEDIA_SUFFIXES.items())


def test_raw_suffix_table_matches_code():
    assert _table_rows("| 后缀 | mime_type |") == set(RAW_SUFFIXES.items())


@pytest.mark.parametrize(
    "pattern",
    [
        TEAM_LIBRARY_ID_PATTERN, TEAM_ASSET_ID_PATTERN, TEAM_RECIPE_INPUT_PATH_PATTERN,
        SHA256_PATTERN, _CONFLICT_SUFFIX.pattern,
    ],
)
def test_doc_quotes_patterns_verbatim(pattern: str):
    assert f"`{pattern}`" in _doc_text()
