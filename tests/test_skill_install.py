import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "install.sh"

# install.sh 是 macOS/Linux 的安装路径（POSIX 符号链接）；Windows 侧由 install.ps1 负责，
# 下面单独有 test_powershell_* 覆盖。Windows runner 上 bash 跑得起来，但建符号链接要开发者模式
# 或管理员权限，这几条走 install.sh 的必然非零退出 —— 按平台分流，与那条 PowerShell 测试镜像对称。
posix_only = pytest.mark.skipif(
    os.name == "nt", reason="install.sh 只覆盖 macOS/Linux；Windows 侧由 install.ps1 与其专属测试负责"
)


def _skill_names() -> set[str]:
    return {
        path.parent.name
        for path in (REPO_ROOT / "skills").glob("*/SKILL.md")
    }


def _run_install(home: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    return subprocess.run(
        ["bash", str(INSTALL_SH), *args],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )


def _run_powershell_install(
    home: Path, script: Path, *args: str
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), *args],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )


@posix_only
def test_install_links_every_current_skill(tmp_path: Path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".codex").mkdir()

    result = _run_install(tmp_path)

    assert result.returncode == 0, result.stderr
    assert (tmp_path / ".claude/skills/game-atelier").resolve() == REPO_ROOT
    links = {
        path.name.removeprefix("game-atelier-")
        for path in (tmp_path / ".codex/skills").glob("game-atelier-*")
    }
    assert links == _skill_names()


@posix_only
def test_sync_does_not_create_a_new_local_install(tmp_path: Path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".codex").mkdir()

    result = _run_install(tmp_path, "--sync")

    assert result.returncode == 0, result.stderr
    assert not (tmp_path / ".claude/skills/game-atelier").exists()
    assert not (tmp_path / ".codex/skills").exists()
    assert "未发现本仓库的本地安装" in result.stdout


@posix_only
def test_sync_adds_new_links_prunes_retired_links_and_warns_on_duplicates(tmp_path: Path):
    codex_dir = tmp_path / ".codex/skills"
    codex_dir.mkdir(parents=True)
    (codex_dir / "game-atelier-character").symlink_to(REPO_ROOT / "skills/character")
    (codex_dir / "game-atelier-retired").symlink_to(REPO_ROOT / "skills/retired")
    legacy = codex_dir / "character-workflow"
    legacy.symlink_to(REPO_ROOT / "skills/character")

    result = _run_install(tmp_path, "--sync")

    assert result.returncode == 0, result.stderr
    assert not (codex_dir / "game-atelier-retired").exists()
    assert legacy.is_symlink()
    links = {
        path.name.removeprefix("game-atelier-")
        for path in codex_dir.glob("game-atelier-*")
    }
    assert links == _skill_names()
    assert "Skill 'character' 重复注册" in result.stdout


@posix_only
def test_sync_preserves_foreign_canonical_and_sibling_prefix_links(tmp_path: Path):
    codex_dir = tmp_path / ".codex/skills"
    codex_dir.mkdir(parents=True)
    (codex_dir / "game-atelier-character").symlink_to(REPO_ROOT / "skills/character")

    foreign_skill = tmp_path / "foreign/promo"
    foreign_skill.mkdir(parents=True)
    (foreign_skill / "SKILL.md").write_text("---\nname: promo\n---\n", encoding="utf-8")
    foreign_canonical = codex_dir / "game-atelier-promo"
    foreign_canonical.symlink_to(foreign_skill)

    sibling_prefix = codex_dir / "game-atelier-retired"
    sibling_prefix.symlink_to(Path(f"{REPO_ROOT}-backup") / "skills/retired")

    result = _run_install(tmp_path, "--sync")

    assert result.returncode == 0, result.stderr
    assert foreign_canonical.resolve() == foreign_skill
    assert sibling_prefix.is_symlink()
    assert "目标已存在且不属于本仓库" in result.stdout


def test_launchers_sync_existing_skills_after_repository_updates():
    studio = (REPO_ROOT / "scripts/studio.sh").read_text(encoding="utf-8")
    windows = (REPO_ROOT / "Windows一键启动.bat").read_text(encoding="utf-8-sig")
    powershell = (REPO_ROOT / "install.ps1").read_text(encoding="utf-8-sig")

    # 断言里不写仓库根变量名：scripts/check_no_project_root.sh 禁止 .py 里出现那个旧环境变量名
    # （shell 脚本里的同名局部变量不在守卫范围内）。这里与下面 Windows 那条同款，只断调用形态。
    assert 'install.sh" --sync' in studio
    assert 'install.ps1" -Sync' in windows
    assert "[switch]$Sync" in powershell


@pytest.mark.skipif(os.name != "nt", reason="PowerShell/Junction semantics require Windows")
def test_powershell_sync_preserves_foreign_canonical_and_sibling_prefix_links(tmp_path: Path):
    fake_repo = tmp_path / "checkout/game-atelier"
    fake_repo.mkdir(parents=True)
    shutil.copy2(REPO_ROOT / "install.ps1", fake_repo / "install.ps1")
    for name in ("character", "promo"):
        skill_dir = fake_repo / "skills" / name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(f"---\nname: {name}\n---\n", encoding="utf-8")

    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".codex").mkdir()
    first_install = _run_powershell_install(home, fake_repo / "install.ps1")
    assert first_install.returncode == 0, first_install.stderr

    codex_dir = home / ".codex/skills"
    foreign_skill = tmp_path / "foreign/promo"
    foreign_skill.mkdir(parents=True)
    (foreign_skill / "SKILL.md").write_text("---\nname: promo\n---\n", encoding="utf-8")
    sibling_skill = tmp_path / "checkout/game-atelier-backup/skills/retired"
    sibling_skill.mkdir(parents=True)
    foreign_canonical = codex_dir / "game-atelier-promo"
    sibling_prefix = codex_dir / "game-atelier-retired"
    setup_links = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            (
                f"Remove-Item -LiteralPath '{foreign_canonical}' -Force -Recurse; "
                f"New-Item -ItemType Junction -Path '{foreign_canonical}' -Target '{foreign_skill}'; "
                f"New-Item -ItemType Junction -Path '{sibling_prefix}' -Target '{sibling_skill}'"
            ),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert setup_links.returncode == 0, setup_links.stderr

    result = _run_powershell_install(home, fake_repo / "install.ps1", "-Sync")

    assert result.returncode == 0, result.stderr
    assert foreign_canonical.resolve() == foreign_skill.resolve()
    assert sibling_prefix.resolve() == sibling_skill.resolve()
    assert "目标已存在且不属于本仓库" in result.stdout
