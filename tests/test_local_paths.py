"""data_root_file：数据根内、非 .config、.runtime 只认 uploads、symlink 展开后再判。"""
from __future__ import annotations

from pathlib import Path

import pytest

from character_workflow.lib.local_paths import DataRootFileMissing, data_root_file


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    return path


@pytest.mark.parametrize("relative", [
    ".runtime/uploads/a.png",
    "creation-assets/blobs/" + "a" * 64 + ".png",
    "studio/job-1/out.png",
    "characters/holy/portrait/v1.png",
])
def test_accepts_files_inside_data_root(isolated_data_root, relative):
    target = _touch(isolated_data_root / relative)

    assert data_root_file(str(target)) == target.resolve()
    assert data_root_file(relative) == target.resolve()


@pytest.mark.parametrize("relative", [
    ".config/keys.json",
    ".runtime/jobs/x.json",
    ".runtime/uploads",
])
def test_rejects_private_areas_of_data_root(isolated_data_root, relative):
    target = isolated_data_root / relative
    if not target.exists():
        _touch(target)

    with pytest.raises(ValueError, match="不在允许打包的目录内"):
        data_root_file(str(target))


def test_rejects_data_root_itself(isolated_data_root):
    with pytest.raises(ValueError, match="不在允许打包的目录内"):
        data_root_file(str(isolated_data_root))


@pytest.mark.parametrize("value", ["/etc/hosts", str(Path.home() / ".ssh" / "id_rsa")])
def test_rejects_paths_outside_data_root_even_when_missing(value):
    with pytest.raises(ValueError, match="不在数据目录内") as caught:
        data_root_file(value)
    assert not isinstance(caught.value, DataRootFileMissing)


def test_rejects_dot_dot_traversal(isolated_data_root):
    _touch(isolated_data_root / ".config" / "keys.json")
    outside = _touch(isolated_data_root.parent / "outside.png")

    with pytest.raises(ValueError, match="不在允许打包的目录内"):
        data_root_file(str(isolated_data_root / ".runtime/uploads/../../.config/keys.json"))
    with pytest.raises(ValueError, match="不在数据目录内"):
        data_root_file(f"characters/../../{outside.name}")


def test_rejects_symlink_pointing_outside(isolated_data_root):
    secret = _touch(isolated_data_root.parent / "secret.png")
    link = isolated_data_root / ".runtime" / "uploads" / "a.png"
    link.parent.mkdir(parents=True)
    link.symlink_to(secret)

    with pytest.raises(ValueError, match="不在数据目录内"):
        data_root_file(str(link))


def test_missing_file_inside_data_root_is_its_own_error(isolated_data_root):
    with pytest.raises(DataRootFileMissing, match="本机找不到文件：gone.png"):
        data_root_file(str(isolated_data_root / "studio" / "j" / "gone.png"))


def test_rejects_web_urls():
    with pytest.raises(ValueError, match="网络地址"):
        data_root_file("https://example.com/a.png")
