import pytest
from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib import keys, model_routes
from viewer_server.connection_capabilities import local_capability
from viewer_server.server_app import build_app


def _key(alias: str, provider: str, models: list[dict], **extra) -> dict:
    return {
        "alias": alias, "provider": provider, "access_key": f"{alias}-ak",
        "models": models, "created_at": "2026-10-15T00:00:00+08:00", **extra,
    }


def _seed(default_alias: str | None = "Tuzi", model_order: dict | None = None) -> None:
    keys.write_keys_db(keys.KeysDB.model_validate({
        "default_alias": default_alias,
        "model_order": model_order or {},
        "keys": [
            _key("HK", "custom", [
                {"id": "gpt-image-2", "name": "GPT Image 2", "modality": "image"},
                {"id": "nano-banana", "name": "Nano Banana", "modality": "image"},
            ], base_url="https://api.openai-hk.com/v1"),
            _key("Tuzi", "custom", [
                {"id": "gpt-image-2", "name": "gpt-image-2", "modality": "image"},
                {"id": "claude-sonnet-5-5", "name": "Sonnet", "modality": "text"},
            ], base_url="https://api.tu-zi.com/v1"),
            _key("OpenRouter", "openrouter", [
                {"id": "openai/gpt-image-2", "name": "OR GPT Image 2", "modality": "image"},
                {"id": "bytedance/seedance-2.0", "name": "Seedance OR", "modality": "video",
                 "protocol": "openrouter"},
            ]),
            _key("tokendance", "tokendance", [
                {"id": "seedance-2.0", "name": "Seedance 2.0", "modality": "video",
                 "protocol": "seedance"},
            ]),
        ],
    }))


def _route(modality: str, identifier: str) -> model_routes.ModelRoute:
    return model_routes.find_route(modality, identifier)


def test_same_model_across_providers_forms_one_route_with_default_key_first(isolated_data_root):
    _seed()
    route = _route("image", "gpt-image-2")
    assert [m.alias for m in route.members] == ["Tuzi", "HK", "OpenRouter"]
    assert [m.model_id for m in route.members] == ["gpt-image-2", "gpt-image-2", "openai/gpt-image-2"]
    assert route.name == "gpt-image-2"


def test_single_provider_models_are_routes_too(isolated_data_root):
    _seed()
    assert [m.alias for m in _route("image", "nano-banana").members] == ["HK"]
    assert [m.alias for m in _route("text", "claude-sonnet-5-5").members] == ["Tuzi"]


def test_video_routes_with_different_protocols_stay_apart(isolated_data_root):
    _seed()
    ids = {route.id for route in model_routes.list_routes("video")}
    assert ids == {"openrouter:seedance-2.0", "seedance:seedance-2.0"}


def test_saved_order_wins_and_new_members_go_last(isolated_data_root):
    _seed(model_order={"image": {"gpt-image-2": ["OpenRouter", "HK"]}})
    assert [m.alias for m in _route("image", "gpt-image-2").members] == ["OpenRouter", "HK", "Tuzi"]


def test_resolve_auto_returns_first_member_key_and_model(isolated_data_root):
    _seed(model_order={"image": {"gpt-image-2": ["OpenRouter", "HK", "Tuzi"]}})
    key, model = model_routes.resolve_auto("image", "gpt-image-2")
    assert (key.alias, model.id) == ("OpenRouter", "openai/gpt-image-2")


def test_resolve_auto_unknown_model_names_it(isolated_data_root):
    _seed()
    with pytest.raises(model_routes.NoSuchRouteError, match="未配置模型 flux-9"):
        model_routes.resolve_auto("image", "flux-9")


def test_set_order_requires_exact_member_set(isolated_data_root):
    _seed()
    with pytest.raises(model_routes.InvalidRouteOrderError):
        model_routes.set_route_order("image", "gpt-image-2", ["HK", "Tuzi"])
    route = model_routes.set_route_order("image", "gpt-image-2", ["HK", "OpenRouter", "Tuzi"])
    assert [m.alias for m in route.members] == ["HK", "OpenRouter", "Tuzi"]
    assert keys.read_keys_db().model_order == {"image": {"gpt-image-2": ["HK", "OpenRouter", "Tuzi"]}}


def test_delete_key_drops_it_from_saved_orders(isolated_data_root):
    _seed(model_order={"image": {"gpt-image-2": ["HK", "Tuzi"], "nano-banana": ["HK"]}})
    keys.delete_key("HK")
    assert keys.read_keys_db().model_order == {"image": {"gpt-image-2": ["Tuzi"]}}


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app())


def test_models_api_lists_routes_and_reorders(client):
    _seed()
    body = client.get("/api/models").json()
    gpt = next(row for row in body["models"] if row["id"] == "gpt-image-2")
    assert [m["alias"] for m in gpt["members"]] == ["Tuzi", "HK", "OpenRouter"]
    assert all("access_key" not in m for row in body["models"] for m in row["members"])

    response = client.put("/api/models/order", json={
        "modality": "image", "id": "gpt-image-2", "aliases": ["OpenRouter", "Tuzi", "HK"],
    })
    assert response.status_code == 200, response.text
    assert [m["alias"] for m in response.json()["members"]] == ["OpenRouter", "Tuzi", "HK"]

    assert client.put("/api/models/order", json={
        "modality": "image", "id": "gpt-image-2", "aliases": ["HK"],
    }).status_code == 422
    assert client.put("/api/models/order", json={
        "modality": "image", "id": "missing", "aliases": ["HK"],
    }).status_code == 404


def test_reordering_is_management_listing_is_read():
    assert local_capability("GET", "/api/models") == "read"
    assert local_capability("PUT", "/api/models/order") == "manage"


def test_canvas_draft_without_alias_routes_and_pinned_alias_does_not(isolated_data_root):
    from types import SimpleNamespace

    from character_workflow.lib.canvas_runs import _resolve_key_and_model

    _seed(model_order={"image": {"gpt-image-2": ["HK", "Tuzi", "OpenRouter"]}})
    key, model, _ = _resolve_key_and_model(SimpleNamespace(alias=None, model="gpt-image-2", mode="image"))
    assert (key.alias, model.id) == ("HK", "gpt-image-2")
    key, model, _ = _resolve_key_and_model(
        SimpleNamespace(alias="OpenRouter", model="openai/gpt-image-2", mode="image"))
    assert (key.alias, model.id) == ("OpenRouter", "openai/gpt-image-2")
    with pytest.raises(ValueError, match="未配置模型 flux-9"):
        _resolve_key_and_model(SimpleNamespace(alias=None, model="flux-9", mode="image"))


def test_preference_selection_without_alias_routes(isolated_data_root):
    from character_workflow.lib.canvas_runs import _selected_key_and_model
    from character_workflow.lib.schemas import CanvasGenerationModelSelection

    _seed()
    key, model = _selected_key_and_model(CanvasGenerationModelSelection(model="gpt-image-2"), "image")
    assert (key.alias, model.id) == ("Tuzi", "gpt-image-2")
    assert _selected_key_and_model(CanvasGenerationModelSelection(model="flux-9"), "image") is None
    assert _selected_key_and_model(
        CanvasGenerationModelSelection(alias="HK", model="nano-banana"), "image",
    )[0].alias == "HK"
