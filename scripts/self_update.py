"""一键启动的源码更新：Mac / Linux（scripts/studio.sh）与 Windows（Windows一键启动.bat）共用。

只用标准库，在 `uv sync` 之前运行（项目依赖可能还没装）。
退出码：0 = 继续启动；10 = 代码已更新，启动器应以 --skip-update 重新运行自己。

更新源：先 CNB 国内镜像（只有 main，拉进 origin/main），不通再走 origin。
有新版直接 fast-forward，不询问；被本地改动挡住时，列出挡路文件并可只暂存这些文件后更新。
"""

from __future__ import annotations

import re
import socket
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CNB_URL = "https://cnb.cool/ZhongBiao-zheng/game-atelier.git"
PROBE_HOSTS = ("cnb.cool", "github.com")
PROBE_TIMEOUT = 3  # 秒；两个源并行探测，断网时最多等这么久
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


def reachable(host: str) -> bool:
    try:
        with socket.create_connection((host, 443), timeout=PROBE_TIMEOUT):
            return True
    except OSError:
        return False


def probe() -> dict[str, bool]:
    with ThreadPoolExecutor(len(PROBE_HOSTS)) as pool:
        return dict(zip(PROBE_HOSTS, pool.map(reachable, PROBE_HOSTS)))


def fetch(online: dict[str, bool]) -> bool:
    # 镜像比本地 origin/main 旧（同步还没跑完）时非 fast-forward 被拒，回落 origin。
    if online.get("cnb.cool") and git(*FETCH_ARGS, CNB_URL, "main:refs/remotes/origin/main").returncode == 0:
        return True
    return bool(online.get("github.com")) and git(*FETCH_ARGS).returncode == 0


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


def resolve_upstream(branch: str) -> str | None:
    upstream = out("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    if upstream:
        return upstream
    warn(f"分支 {branch} 没有上游，无法自动更新")
    if not out("rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"):
        return None
    if out("status", "--porcelain"):
        print("工作区有改动，请手动 git switch main")
        return None
    if ask("[1] 切到 main 并更新  [2] 直接启动: ", "1") == "2":
        return None
    if git("switch", "main").returncode != 0:
        warn("切换失败，请手动 git switch main")
        return None
    return "origin/main"


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

    if not fetch(probe()):
        warn("连不上更新源，跳过更新")
        return 0
    restore_dist()

    upstream = resolve_upstream(branch)
    if upstream is None:
        return 0
    if out("rev-list", "--count", f"HEAD..{upstream}") in ("", "0"):
        print("已是最新")
        return 0

    new_version = version_at(upstream)
    print(f"发现新版本 {current} → {new_version}")
    for line in headlines_between(current, upstream):
        print(f"  {line}")
    return fast_forward(upstream, new_version)


if __name__ == "__main__":
    sys.exit(main())
