import re
from pathlib import Path

from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib import data_root
from character_workflow.lib.schemas import (
    ACCENT_USER_THEME_MAX,
    BUILTIN_ACCENT_THEMES,
)
from viewer_server.server_app import build_app

COLORS = {"primary": "#112233", "brand2": "#445566", "brand3": "#778899", "brand4": "#AABBCC"}


def _client(isolated_data_root) -> TestClient:
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _theme(index: int = 0, name: str | None = None) -> dict:
    return {"id": f"u-theme{index:04d}", "name": name or f"主题{index}", **COLORS}


def _payload(revision: int = 0, **changes) -> dict:
    return {"expected_revision": revision, "active": "lime", "overrides": {}, "custom": [], **changes}


def test_builtin_theme_catalog_matches_web_presets():
    source = (Path(__file__).resolve().parents[1] / "web/src/lib/accentPresets.ts").read_text(encoding="utf-8")
    web = dict(re.findall(r"id: '([a-z]+)', name: '([^']+)'", source))
    assert web == BUILTIN_ACCENT_THEMES


def test_missing_file_reads_default_without_creating_it(isolated_data_root):
    response = _client(isolated_data_root).get("/api/accent-themes")

    assert response.status_code == 200
    assert response.json() == {"schema_version": 1, "revision": 0, "active": "lime", "overrides": {}, "custom": [], "updated_at": None}
    assert not data_root.accent_themes_file().exists()


def test_save_round_trips_and_strips_names(isolated_data_root):
    client = _client(isolated_data_root)
    saved = client.put("/api/accent-themes", json=_payload(
        active="u-theme0001",
        overrides={"lime": COLORS},
        custom=[_theme(1, "  晚霞  ")],
    ))

    assert saved.status_code == 200
    body = saved.json()
    assert body["revision"] == 1
    assert body["custom"] == [{**_theme(1), "name": "晚霞"}]
    assert body["overrides"] == {"lime": COLORS}
    assert client.get("/api/accent-themes").json() == body


def test_stale_revision_is_rejected_and_file_unchanged(isolated_data_root):
    client = _client(isolated_data_root)
    assert client.put("/api/accent-themes", json=_payload()).status_code == 200
    original = data_root.accent_themes_file().read_bytes()

    stale = client.put("/api/accent-themes", json=_payload(active="blue"))

    assert stale.status_code == 409
    assert stale.json()["detail"]["current_revision"] == 1
    assert data_root.accent_themes_file().read_bytes() == original


def test_invalid_documents_are_rejected(isolated_data_root):
    client = _client(isolated_data_root)
    bad = [
        _payload(custom=[{**_theme(1), "primary": "#12345"}]),
        _payload(custom=[{**_theme(1), "primary": "red"}]),
        _payload(overrides={"lime": {**COLORS, "brand2": "#GGGGGG"}}),
        _payload(custom=[_theme(1, "   ")]),
        _payload(custom=[_theme(1, "超" * 13)]),
        _payload(custom=[_theme(1, "晚霞"), _theme(2, "晚霞")]),
        _payload(custom=[_theme(1, "Dusk"), _theme(2, "dusk")]),
        _payload(custom=[_theme(1, "青柠")]),
        _payload(custom=[_theme(1), {**_theme(2), "id": "u-theme0001"}]),
        _payload(custom=[{**_theme(1), "id": "lime"}]),
        _payload(active="u-missing00"),
        _payload(overrides={"mint": COLORS}),
        _payload(custom=[_theme(i) for i in range(ACCENT_USER_THEME_MAX + 1)]),
        {**_payload(), "extra": True},
    ]
    for payload in bad:
        assert client.put("/api/accent-themes", json=payload).status_code == 422, payload
    assert not data_root.accent_themes_file().exists()
    full = _payload(custom=[_theme(i) for i in range(ACCENT_USER_THEME_MAX)])
    assert client.put("/api/accent-themes", json=full).status_code == 200


def test_corrupt_file_is_reported_and_never_overwritten(isolated_data_root):
    path = data_root.accent_themes_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"schema_version": 1, "revision": 2, "active": "nope"}', encoding="utf-8")
    original = path.read_bytes()
    client = _client(isolated_data_root)

    read = client.get("/api/accent-themes")
    write = client.put("/api/accent-themes", json=_payload(2))

    assert read.status_code == 500
    assert "accent-themes.json" in read.json()["detail"]
    assert write.status_code == 500
    assert path.read_bytes() == original
