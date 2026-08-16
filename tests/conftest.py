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
    return root
