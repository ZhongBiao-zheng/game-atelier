import pytest


@pytest.fixture(autouse=True)
def isolated_data_root(tmp_path, monkeypatch):
    """Every test gets a clean data root via CHARACTER_WORKFLOW_DATA_ROOT.

    Pollutes neither user data nor other tests. Keeps PROJECT_ROOT untouched
    until Phase 2 migrates code paths.
    """
    root = tmp_path / "wf-data-root"
    root.mkdir()
    (root / ".config").mkdir()
    (root / ".runtime").mkdir()
    (root / "projects").mkdir()
    (root / "characters").mkdir()
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(root))
    return root
