import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
POSIX_REPAIR = REPO_ROOT / "scripts/repair-update.sh"


def _read(path: str, encoding: str = "utf-8") -> str:
    return (REPO_ROOT / path).read_text(encoding=encoding)


def test_one_click_launchers_only_consume_committed_dist():
    mac = _read("scripts/studio.sh")
    windows = _read("Windows一键启动.bat", "utf-8-sig")

    for launcher in (mac, windows):
        assert "pnpm build" not in launcher
        assert "pnpm install" not in launcher
        assert "web/dist/index.html" in launcher or "web\\dist\\index.html" in launcher
        assert "一键修复" in launcher


def test_repair_scripts_are_scoped_to_dist_and_never_hard_reset():
    mac = _read("scripts/repair-update.sh")
    windows = _read("Windows一键修复.bat", "utf-8-sig")

    for script in (mac, windows):
        assert "web/dist" in script or "web\\dist" in script
        assert "reset --hard" not in script
        assert "git restore" in script
        assert "git clean" in script
        assert "pull --ff-only" in script


@pytest.mark.skipif(os.name == "nt", reason="POSIX repair behavior is covered on macOS/Linux")
def test_posix_repair_restores_only_dist_and_preserves_other_changes(tmp_path: Path):
    repo = tmp_path / "checkout"
    (repo / "scripts").mkdir(parents=True)
    (repo / "web/dist/assets").mkdir(parents=True)
    shutil.copy2(POSIX_REPAIR, repo / "scripts/repair-update.sh")
    (repo / "web/dist/index.html").write_text("release", encoding="utf-8")
    (repo / "notes.txt").write_text("keep", encoding="utf-8")

    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True)

    (repo / "web/dist/index.html").write_text("locally rebuilt", encoding="utf-8")
    (repo / "web/dist/assets/generated.js").write_text("generated", encoding="utf-8")
    (repo / "notes.txt").write_text("user change", encoding="utf-8")
    # 旧启动器或用户可能已经把生成结果暂存；修复也必须只撤销 dist 的 index 改动。
    subprocess.run(["git", "add", "web/dist"], cwd=repo, check=True)

    result = subprocess.run(
        ["bash", str(repo / "scripts/repair-update.sh"), "--repair-only"],
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert (repo / "web/dist/index.html").read_text(encoding="utf-8") == "release"
    assert not (repo / "web/dist/assets/generated.js").exists()
    assert (repo / "notes.txt").read_text(encoding="utf-8") == "user change"
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", "web/dist"],
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    )
    assert status.stdout == ""


def test_readme_contains_bootstrap_recovery_commands():
    readme = _read("README.md")
    assert "git restore --source=HEAD --staged --worktree -- web/dist" in readme
    assert "git clean -fd -- web/dist" in readme
    assert "一键修复" in readme
