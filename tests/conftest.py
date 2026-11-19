import pytest


@pytest.fixture(autouse=True)
def isolated_data_root(tmp_path, monkeypatch):
    """Every test gets a clean data root via GAME_ATELIER_DATA_ROOT.

    Pollutes neither user data nor other tests.
    """
    root = tmp_path / "wf-data-root"
    root.mkdir()
    (root / ".config").mkdir()
    (root / ".runtime").mkdir()
    (root / "projects").mkdir()
    (root / "characters").mkdir()
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(root))
    # 更新检查关网禁写：子进程跑 bootstrap --check 时既不联 GitHub 也不写真实用户 config 目录
    monkeypatch.setenv("GAME_ATELIER_NO_UPDATE_CHECK", "1")
    monkeypatch.delenv("GAME_ATELIER_DEV_ORIGIN", raising=False)
    # 打开 Agent 开关会写 Codex 配置：指到不存在的目录，测试绝不碰真实的 ~/.codex/config.toml。
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home-absent"))
    # Cursor / Claude Desktop 等客户端配置在用户目录下：同样指到临时目录（服务启动会改写已有条目）。
    from viewer_server import agent_clients
    client_home = tmp_path / "client-home"
    monkeypatch.setattr(agent_clients, "_home", lambda: client_home)
    monkeypatch.setenv("APPDATA", str(client_home / "AppData" / "Roaming"))
    # 服务启动会起价格同步线程：测试里关掉，绝不联外网。
    from character_workflow.lib import (
        announcement_feed, openai_hk_prices, tokendance_prices, tuzi_prices,
    )
    monkeypatch.setattr(tokendance_prices, "start_background_sync", lambda: None)
    monkeypatch.setattr(tokendance_prices, "start_missing_sync", lambda: None)

    def offline_pricing(origin, model_id):
        raise tokendance_prices.requests.ConnectionError("tests are offline")

    monkeypatch.setattr(tokendance_prices, "_fetch_pricing", offline_pricing)
    monkeypatch.setattr(tokendance_prices, "_missing_attempts", {})
    monkeypatch.setattr(tuzi_prices, "start_background_sync", lambda: None)
    monkeypatch.setattr(openai_hk_prices, "start_background_sync", lambda: None)
    # 公告源同理：启动不拉 CNB / GitHub。
    monkeypatch.setattr(announcement_feed, "start_background_sync", lambda: None)
    return root
