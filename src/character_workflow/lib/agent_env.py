"""程序化探测当前 AI 代理运行时 —— 取代散落的 `~/.claude` 硬编码。

设计：把「我跑在哪个工具里、它的约定记忆文件叫什么、它的家目录在哪」收敛成
一个纯函数 `detect_agent()`，供 `doctor` 报告与 `agent-env` CLI 查询。任何需要
按工具分流的逻辑都调它，不再各自 hardcode。

信号优先级（高 → 低）：
1. `AI_AGENT` 前缀（跨工具新兴约定）："claude-code_2-1-161_agent" / "codex_..."
2. Claude 专属环境变量：`CLAUDECODE` / `CLAUDE_PLUGIN_ROOT` / `CLAUDE_CODE_ENTRYPOINT`
3. Codex 专属环境变量：`CODEX_*`（真机取值待确认，保留前缀探测兜底）
4. 兜底 unknown：约定文件用跨工具事实标准 AGENTS.md

注：Claude 实测 `AI_AGENT=claude-code_<ver>_agent` + `CLAUDECODE=1`；Codex 注入取值
需真机确认，故 (1) 命中前 (2)/(3) 必须能独立判别。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AgentEnv:
    tool: str  # "claude" | "codex" | "unknown"
    convention_file: str  # 该工具读取项目记忆的约定文件名
    agent_home: Path  # 该工具的用户级目录（~/.claude | ~/.codex | ~）


def _home() -> Path:
    return Path(os.environ.get("HOME") or os.path.expanduser("~")).expanduser()


def detect_agent(env: dict[str, str] | None = None) -> AgentEnv:
    """探测当前代理运行时。`env` 可注入用于测试，缺省读 `os.environ`。"""
    env = os.environ if env is None else env
    home = _home()
    ai_agent = (env.get("AI_AGENT") or "").lower()

    # 1. AI_AGENT 前缀（跨工具约定，最高优先）
    if ai_agent.startswith("claude"):
        return AgentEnv("claude", "CLAUDE.md", home / ".claude")
    if ai_agent.startswith("codex"):
        return AgentEnv("codex", "AGENTS.md", home / ".codex")

    # 2. Claude 专属信号
    if env.get("CLAUDECODE") or env.get("CLAUDE_PLUGIN_ROOT") or env.get("CLAUDE_CODE_ENTRYPOINT"):
        return AgentEnv("claude", "CLAUDE.md", home / ".claude")

    # 3. Codex 专属信号（前缀兜底，真机取值待确认）
    if env.get("CODEX_SANDBOX") or any(k.startswith("CODEX_") for k in env):
        return AgentEnv("codex", "AGENTS.md", home / ".codex")

    # 4. 兜底：AGENTS.md 是跨工具事实标准
    return AgentEnv("unknown", "AGENTS.md", home)


def as_dict(agent: AgentEnv | None = None) -> dict:
    """JSON 友好表示，供 CLI / doctor 输出。"""
    a = detect_agent() if agent is None else agent
    return {
        "tool": a.tool,
        "convention_file": a.convention_file,
        "agent_home": str(a.agent_home),
    }
