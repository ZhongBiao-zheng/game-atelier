"""环境自诊断 —— 专治「源码=数据=CWD 揉一起」与运行时困惑。

`diagnose()` 返回结构化 findings（level: ok|info|warn|error），SKILL.md / 人都能读。
不改任何文件，只读 + 报告 + 给建议。
"""
from __future__ import annotations

import os
from pathlib import Path

from character_workflow.lib import agent_env, data_root


def _data_root_source() -> tuple[Path, str]:
    """返回 (data_root, 来源)。来源 ∈ env / config / default。"""
    if os.environ.get(data_root._ENV_VAR):
        return data_root.resolve_data_root(), "env"
    cfg = data_root._global_config_file()
    if cfg.exists() and cfg.read_text(encoding="utf-8").strip():
        return data_root.resolve_data_root(), "config"
    return data_root.resolve_data_root(), "default"


def _is_git_repo(p: Path) -> bool:
    return (p / ".git").exists()


def _find_enclosing_git_repo(start: Path) -> Path | None:
    for d in (start, *start.parents):
        if (d / ".git").exists():
            return d
    return None


def diagnose() -> dict:
    findings: list[dict] = []

    def add(level: str, code: str, message: str, suggestion: str = "") -> None:
        findings.append(
            {"level": level, "code": code, "message": message, "suggestion": suggestion}
        )

    dr, source = _data_root_source()
    cwd = Path.cwd().resolve()
    agent = agent_env.detect_agent()

    # 1. data_root 解析来源
    if source == "default":
        add(
            "warn",
            "data_root_default",
            f"data_root 未显式配置，回落默认 {dr}",
            "首启向导跑 bootstrap.py --init-data-root <独立数据目录>，把数据目录固定下来。",
        )
    else:
        add("ok", "data_root_resolved", f"data_root = {dr}（来源：{source}）")

    # 2. data_root 是否=git 仓库（源码与数据混在一起）
    if _is_git_repo(dr):
        add(
            "warn",
            "data_root_is_git",
            f"data_root({dr}) 本身是个 git 仓库，源码与出图数据混在一起",
            "把 data_root 指向一个独立的纯数据目录（如 ~/game-atelier 或 D:\\game-atelier-data），"
            "源码仓库只放代码。",
        )

    # 3. 代理 CWD 与 data_root 的关系（决定沙箱写入是否弹窗）
    if cwd == dr:
        add("ok", "cwd_is_data_root", f"代理 CWD == data_root（{dr}），沙箱可写根覆盖数据目录")
    else:
        inside = dr == cwd or dr in cwd.parents or cwd in dr.parents
        add(
            "info" if inside else "warn",
            "cwd_neq_data_root",
            f"代理 CWD（{cwd}）≠ data_root（{dr}）——数据位置不受影响，但写入可能落在沙箱可写根之外",
            "若代理（尤其 Codex）频繁弹出写入/缓存权限，建议从 data_root 目录启动代理。",
        )

    # 4. CWD 是否在某个 git 仓库内（可能就是源码仓库当工作区）
    repo = _find_enclosing_git_repo(cwd)
    if repo is not None and repo != dr:
        add(
            "info",
            "cwd_in_git_repo",
            f"代理 CWD 位于 git 仓库 {repo} 内",
            "用源码仓库当代理工作区可以，但出图数据始终落在 data_root，二者解耦——不必混放。",
        )

    # 5. venv 是否就绪
    venv_py = data_root.venv_python()
    if venv_py.exists():
        add("ok", "venv_ready", f"venv 就绪：{venv_py}（per-turn 直跑它，零 uv）")
    else:
        add(
            "warn",
            "venv_missing",
            f"venv 未构建：{venv_py} 不存在",
            "跑 bootstrap.py --ensure-venv（一次性，会用 uv sync 建好依赖）。",
        )

    # 6. 当前代理 + 约定文件
    add(
        "ok",
        "agent_detected",
        f"当前代理：{agent.tool}，约定记忆文件：{agent.convention_file}，家目录：{agent.agent_home}",
    )

    ok = not any(f["level"] == "error" for f in findings)
    return {
        "ok": ok,
        "data_root": str(dr),
        "data_root_source": source,
        "cwd": str(cwd),
        "agent": agent_env.as_dict(agent),
        "venv_python": str(venv_py),
        "findings": findings,
    }
