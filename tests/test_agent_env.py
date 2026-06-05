"""detect_agent() 跨代理探测测试。"""
import pytest

from character_workflow.lib import agent_env


@pytest.fixture(autouse=True)
def fake_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def test_ai_agent_claude_prefix():
    a = agent_env.detect_agent({"AI_AGENT": "claude-code_2-1-161_agent"})
    assert a.tool == "claude"
    assert a.convention_file == "CLAUDE.md"
    assert a.agent_home.name == ".claude"


def test_ai_agent_codex_prefix():
    a = agent_env.detect_agent({"AI_AGENT": "codex_1-0_agent"})
    assert a.tool == "codex"
    assert a.convention_file == "AGENTS.md"
    assert a.agent_home.name == ".codex"


def test_claudecode_signal_without_ai_agent():
    a = agent_env.detect_agent({"CLAUDECODE": "1"})
    assert a.tool == "claude"


def test_claude_plugin_root_signal():
    a = agent_env.detect_agent({"CLAUDE_PLUGIN_ROOT": "/x/y"})
    assert a.tool == "claude"


def test_codex_env_prefix_signal():
    a = agent_env.detect_agent({"CODEX_SANDBOX": "workspace-write"})
    assert a.tool == "codex"
    assert a.convention_file == "AGENTS.md"


def test_unknown_fallback_uses_agents_md():
    a = agent_env.detect_agent({})
    assert a.tool == "unknown"
    assert a.convention_file == "AGENTS.md"


def test_ai_agent_beats_other_signals():
    # AI_AGENT 优先级高于 CLAUDECODE
    a = agent_env.detect_agent({"AI_AGENT": "codex_x", "CLAUDECODE": "1"})
    assert a.tool == "codex"


def test_as_dict_shape():
    d = agent_env.as_dict(agent_env.detect_agent({"AI_AGENT": "claude-code_x"}))
    assert set(d) == {"tool", "convention_file", "agent_home"}
    assert d["tool"] == "claude"
    assert isinstance(d["agent_home"], str)
