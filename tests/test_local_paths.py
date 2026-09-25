"""data_root_file：数据根内、非 .config、.runtime 只认 uploads、symlink 展开后再判。"""
from __future__ import annotations

from pathlib import Path

import pytest

from character_workflow.lib.local_paths import DataRootFileMissing, data_root_file

OUTSIDE = "参考文件必须在数据目录内"
PROTECTED = "参考文件在受保护目录内"
INVALID = "参考路径无效"


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    return path


@pytest.mark.parametrize("relative", [
    ".runtime/uploads/a.png",
    ".RUNTIME/Uploads/a.png",
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
    ".runtime/uploads/../jobs/x.json",
])
def test_rejects_private_areas_of_data_root(isolated_data_root, relative):
    _touch(isolated_data_root / ".config" / "keys.json")
    _touch(isolated_data_root / ".runtime" / "jobs" / "x.json")
    (isolated_data_root / ".runtime" / "uploads").mkdir(exist_ok=True)

    with pytest.raises(ValueError, match=PROTECTED):
        data_root_file(str(isolated_data_root / relative))


@pytest.mark.parametrize("relative", [
    ".Config/keys.json", ".CONFIG/keys.json", ".config./keys.json", ".config /keys.json",
    ".RUNTIME/jobs/x.json", ".Runtime/JOBS/x.json", ".runtime/uploads./../jobs/x.json",
])
def test_rejects_case_and_trailing_dot_variants_of_private_areas(isolated_data_root, relative):
    # 大小写不敏感的文件系统上，变体指向同一个真实文件；闸门必须按名字规范化后再判。
    _touch(isolated_data_root / ".config" / "keys.json")
    _touch(isolated_data_root / ".runtime" / "jobs" / "x.json")

    with pytest.raises(ValueError, match=PROTECTED):
        data_root_file(str(isolated_data_root / relative))


def test_rejects_data_root_itself(isolated_data_root):
    with pytest.raises(ValueError, match=PROTECTED):
        data_root_file(str(isolated_data_root))


@pytest.mark.parametrize("value", [
    "/etc/hosts", str(Path.home() / ".ssh" / "id_rsa"), "//etc/hosts",
])
def test_rejects_paths_outside_data_root_even_when_missing(value):
    with pytest.raises(ValueError, match=OUTSIDE) as caught:
        data_root_file(value)
    assert not isinstance(caught.value, DataRootFileMissing)


def test_rejects_dot_dot_traversal(isolated_data_root):
    _touch(isolated_data_root / ".config" / "keys.json")
    outside = _touch(isolated_data_root.parent / "outside.png")

    with pytest.raises(ValueError, match=PROTECTED):
        data_root_file(str(isolated_data_root / ".runtime/uploads/../../.config/keys.json"))
    with pytest.raises(ValueError, match=OUTSIDE):
        data_root_file(f"characters/../../{outside.name}")


def test_rejects_file_symlink_pointing_outside(isolated_data_root):
    secret = _touch(isolated_data_root.parent / "secret.png")
    link = isolated_data_root / ".runtime" / "uploads" / "a.png"
    link.parent.mkdir(parents=True)
    link.symlink_to(secret)

    with pytest.raises(ValueError, match=OUTSIDE):
        data_root_file(str(link))


def test_rejects_directory_symlink_pointing_to_ssh(isolated_data_root):
    # 只建链接、不读目标：~/.ssh 不存在时链接悬空，resolve 结果照样在数据根外。
    link = isolated_data_root / "characters" / "keys"
    link.symlink_to(Path.home() / ".ssh", target_is_directory=True)

    with pytest.raises(ValueError, match=OUTSIDE):
        data_root_file(str(link / "id_rsa"))


def test_missing_file_inside_data_root_is_its_own_error(isolated_data_root):
    with pytest.raises(DataRootFileMissing, match="本机找不到文件：gone.png"):
        data_root_file(str(isolated_data_root / "studio" / "j" / "gone.png"))


@pytest.mark.parametrize("value", ["a\x00b.png", "characters/" + "x" * 300 + ".png"])
def test_rejects_invalid_paths_without_os_error(isolated_data_root, value):
    with pytest.raises(ValueError, match=INVALID):
        data_root_file(value)


def test_rejects_web_urls():
    with pytest.raises(ValueError, match="网络地址不是本机文件"):
        data_root_file("https://example.com/a.png")


@pytest.mark.parametrize("value", [
    "http:///x", "HTTP://evil/../..", "file:///etc/hosts",
])
def test_url_lookalikes_are_judged_as_paths(isolated_data_root, value):
    with pytest.raises(ValueError):
        data_root_file(value)
