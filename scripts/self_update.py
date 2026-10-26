"""一键启动的源码更新：Mac / Linux（scripts/studio.sh）与 Windows（Windows一键启动.bat）共用。

只用标准库，在 `uv sync` 之前运行（项目依赖可能还没装）。
退出码：0 = 继续启动；10 = 代码已更新，启动器应以 --skip-update 重新运行自己。

更新源：CNB 已获发布门禁批准的 tag；不可达时只认 GitHub 已发布 Release。
有新版直接 fast-forward，不询问；被本地改动挡住时，列出挡路文件并可只暂存这些文件后更新。
"""

from __future__ import annotations

import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import bootstrap

REPO = Path(__file__).resolve().parent.parent
EXIT_RESTART = 10
MAX_HEADLINES = 3
FETCH_ARGS = ("-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=20", "fetch", "--quiet")


def git(*args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", *args], cwd=REPO, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
    except FileNotFoundError:
        return subprocess.CompletedProcess(["git", *args], 127, "", "git not found")


def out(*args: str) -> str:
    result = git(*args)
    return result.stdout.strip() if result.returncode == 0 else ""


def warn(message: str) -> None:
    print(f"[警告] {message}")


def ask(prompt: str, default: str) -> str:
    try:
        return input(prompt).strip() or default
    except EOFError:
        return default


def fetch(release: dict) -> bool:
    tag = release["tag"]
    source = bootstrap.CNB_URL if release["source"] == "cnb" else bootstrap.GITHUB_URL
    # 不回退到任何分支；同名 tag 冲突由 Git 拒绝，不强制覆盖。
    return git(*FETCH_ARGS, source, f"refs/tags/{tag}:refs/tags/{tag}").returncode == 0


def restore_dist() -> None:
    """web/dist 是入库的发布产物，本地重建残留会挡住更新；只还原这里，不碰别处。"""
    if git("restore", "--source=HEAD", "--staged", "--worktree", "--", "web/dist").returncode != 0:
        git("checkout", "HEAD", "--", "web/dist")
    git("clean", "-qfd", "--", "web/dist")


def version_at(ref: str) -> str:
    match = re.search(r'"version"\s*:\s*"([^"]+)"', out("show", f"{ref}:.claude-plugin/plugin.json"))
    return match.group(1) if match else "?"


def headlines_between(old: str, ref: str) -> list[str]:
    """更新日志里比 old 新的各版标题（新的在前）。"""
    text = out("show", f"{ref}:web/src/lib/changelog.ts")
    entries = re.findall(r"version: '([^']+)',\s*date: '[^']*',\s*headline: '([^']*)'", text)
    headlines = []
    for version, headline in entries:
        if version == old:
            break
        headlines.append(f"{version}  {headline}")
    return headlines[:MAX_HEADLINES]


def blocking_paths(upstream: str) -> list[str]:
    """本地改动（含未跟踪文件）里，与这次更新改到的文件重叠的那些。"""
    incoming = set(out("diff", "--name-only", f"HEAD...{upstream}").splitlines())
    local = set(out("diff", "--name-only", "HEAD").splitlines())
    local |= set(out("ls-files", "--others", "--exclude-standard").splitlines())
    return sorted(incoming & local)


def ensure_main(branch: str) -> bool:
    if branch == "main":
        return True
    warn(f"当前在 {branch}，自动更新需要切到 main")
    if out("status", "--porcelain"):
        print("工作区有改动，请手动 git switch main")
        return False
    if ask("[1] 切到 main 并更新  [2] 直接启动: ", "2") != "1":
        return False
    if git("switch", "main").returncode != 0:
        warn("切换失败，请手动 git switch main")
        return False
    return True


def fast_forward(upstream: str, new_version: str) -> int:
    if git("merge", "--ff-only", "--quiet", upstream).returncode == 0:
        print(f"已更新到 {new_version}，重新启动...")
        return EXIT_RESTART

    paths = blocking_paths(upstream)
    if not paths:
        warn("本地有未推送的提交，无法自动更新；现在直接启动。")
        return 0
    warn("以下本地改动挡住了更新：")
    for path in paths:
        print(f"  {path}")
    if ask("[1] 暂存这些改动并更新  [2] 跳过更新直接启动: ", "2") != "1":
        return 0
    stash = f"一键启动更新前暂存 {datetime.now():%Y-%m-%d %H:%M}"
    if git("stash", "push", "--include-untracked", "-m", stash, "--", *paths).returncode != 0:
        warn("暂存失败，现在直接启动。")
        return 0
    if git("merge", "--ff-only", "--quiet", upstream).returncode != 0:
        warn(f"暂存后仍无法更新，改动保存在 git stash「{stash}」；现在直接启动。")
        return 0
    print(f"已更新到 {new_version}。你的改动保存在 git stash「{stash}」，需要时运行 git stash pop 取回。")
    return EXIT_RESTART


def main() -> int:
    if not (REPO / ".git").exists():
        warn("不是 git 仓库，无法更新")
        return 0
    if not out("--version"):
        warn("未安装 git，跳过更新")
        return 0

    branch = out("rev-parse", "--abbrev-ref", "HEAD") or "?"
    current = version_at("HEAD")
    print(f"当前 {current}（{branch} @ {out('rev-parse', '--short', 'HEAD') or '?'}）")

    release = bootstrap.latest_release(use_git=True, fresh=True)
    if release is None:
        return 0
    try:
        newer = bootstrap._version_tuple(release["version"]) > bootstrap._version_tuple(current)
    except ValueError:
        warn("本地版本号无效，跳过自动更新")
        return 0
    if not newer:
        print("已是最新")
        return 0
    if not ensure_main(branch):
        return 0
    # 切换分支后重新比较，避免把 main 当成原来的开发分支。
    current = version_at("HEAD")
    if bootstrap._version_tuple(release["version"]) <= bootstrap._version_tuple(current):
        print("已是最新")
        return 0
    if not fetch(release):
        warn("无法获取发布 tag，跳过更新")
        return 0
    tag = release["tag"]
    if version_at(tag) != release["version"]:
        warn("tag 与发布版本不一致，跳过更新")
        return 0
    restore_dist()
    print(f"发现新版本 {current} → {release['version']}")
    for line in headlines_between(current, tag):
        print(f"  {line}")
    return fast_forward(tag, release["version"])


if __name__ == "__main__":
    sys.exit(main())
