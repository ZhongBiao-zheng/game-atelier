"""Where release archives are downloaded from is written once (src/viewer_server/release_sources.json):
the in-app update reads it, and the desktop shell downloads its runtime with the same rules."""
from pathlib import Path

from viewer_server import bundle_download

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE = (REPO_ROOT / "src/viewer_server/bundle_download.py").read_text(encoding="utf-8")


def test_sources_are_tried_cnb_first():
    assert bundle_download.SOURCES == [
        "https://cnb.cool/ZhongBiao-zheng/game-atelier/-/releases",
        "https://github.com/ZhongBiao-zheng/game-atelier/releases",
    ]
    assert bundle_download.CNB == bundle_download.SOURCES[0]


def test_archive_names_and_addresses_match_the_published_assets():
    cnb, github = bundle_download.SOURCES
    windows = bundle_download.asset_name("5.138.0", "windows-x64")
    assert windows == "GameAtelier-5.138.0-windows-x64.zip"
    assert bundle_download.asset_name("5.138.0", "macos-arm64") == "GameAtelier-5.138.0-macos-arm64.tar.gz"
    assert bundle_download.asset_url(cnb, "5.138.0", windows) == (
        "https://cnb.cool/ZhongBiao-zheng/game-atelier/-/releases/download/v5.138.0/"
        "GameAtelier-5.138.0-windows-x64.zip")
    assert bundle_download.asset_url(github, "5.138.0", windows) == (
        "https://github.com/ZhongBiao-zheng/game-atelier/releases/download/v5.138.0/"
        "GameAtelier-5.138.0-windows-x64.zip")
    assert bundle_download.RELEASE["checksum_suffix"] == ".sha256"


def test_the_updater_keeps_no_copy_of_the_download_rules():
    assert "releases/download" not in SOURCE
    assert "github.com/ZhongBiao-zheng/game-atelier/releases\"" not in SOURCE
    assert "GameAtelier-{version}" not in SOURCE


def test_the_desktop_shell_downloads_with_the_same_file():
    stage = (REPO_ROOT / "desktop/scripts/stage.mjs").read_text(encoding="utf-8")
    assert "'src', 'viewer_server', 'release_sources.json'" in stage
    assert "path.join(stage, 'release_sources.json')" in stage
    builder = (REPO_ROOT / "desktop/electron-builder.yml").read_text(encoding="utf-8")
    assert "  - stage/release_sources.json\n" in builder
    download = (REPO_ROOT / "desktop/src/download.mjs").read_text(encoding="utf-8")
    for copy in ("cnb.cool", "github.com", "releases/download", "GameAtelier-$", ".sha256'"):
        assert copy not in download, copy
