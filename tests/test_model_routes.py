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
            ], base_url="https://api.tu-zi.com/v1", billing_group="default"),
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
    assert route.members[0].billing_group == "default"
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
    assert gpt["members"][0]["billing_group"] == "default"
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
    from character_workflow.lib.schemas import JobParams

    from character_workflow.lib.canvas_runs import _resolve_key_and_model

    _seed(model_order={"image": {"gpt-image-2": ["HK", "Tuzi", "OpenRouter"]}})
    key, model, _ = _resolve_key_and_model(SimpleNamespace(alias=None, model="gpt-image-2", mode="image", params=JobParams()))
    assert (key.alias, model.id) == ("HK", "gpt-image-2")
    key, model, _ = _resolve_key_and_model(
        SimpleNamespace(alias="OpenRouter", model="openai/gpt-image-2", mode="image"))
    assert (key.alias, model.id) == ("OpenRouter", "openai/gpt-image-2")
    with pytest.raises(ValueError, match="未配置模型 flux-9"):
        _resolve_key_and_model(SimpleNamespace(alias=None, model="flux-9", mode="image", params=JobParams()))


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


def test_disabled_provider_is_excluded_from_routes_and_canvas_catalog(isolated_data_root):
    from character_workflow.lib.canvas_model_catalog import model_configuration, model_rows
    from character_workflow.lib.canvas_tool_common import CanvasToolError
    from character_workflow.lib.canvas_runs import _resolve_key_and_model, _resolve_layer_decomposition_model
    from character_workflow.lib.schemas import CanvasGenerationDraft

    _seed()
    keys.patch_key("Tuzi", {"enabled": False})
    assert [member.alias for member in _route("image", "gpt-image-2").members] == ["HK", "OpenRouter"]
    assert model_routes.resolve_auto("image", "gpt-image-2")[0].alias == "HK"
    assert all(route.id != "claude-sonnet-5-5" for route in model_routes.list_routes())
    assert all(row["alias"] != "Tuzi" for row in model_rows("image"))
    with pytest.raises(CanvasToolError, match="供应商已停用"):
        model_configuration("Tuzi", "gpt-image-2", "image")
    with pytest.raises(ValueError, match="供应商已停用"):
        _resolve_key_and_model(CanvasGenerationDraft(
            mode="image", alias="Tuzi", model="gpt-image-2", prompt="test",
            updated_at="2026-10-25T00:00:00Z",
        ))
    with pytest.raises(ValueError, match="供应商已停用"):
        _resolve_layer_decomposition_model("Tuzi", "gpt-image-2")
    keys.patch_key("Tuzi", {"enabled": True})
    assert model_routes.resolve_auto("image", "gpt-image-2")[0].alias == "Tuzi"


@pytest.mark.parametrize("dispatch_name", ["dispatch", "dispatch_video", "dispatch_audio", "dispatch_text"])
def test_disabled_provider_cannot_be_dispatched(isolated_data_root, dispatch_name, tmp_path):
    from character_workflow.lib import callers

    _seed()
    keys.patch_key("Tuzi", {"enabled": False})
    with pytest.raises(Exception, match="供应商已停用"):
        getattr(callers, dispatch_name)(prompt="test", model="gpt-image-2", alias="Tuzi", output_dir=tmp_path)


def test_round_robin_preview_and_concurrent_selection_freeze_order():
    from concurrent.futures import ThreadPoolExecutor
    from collections import Counter

    _seed()
    model_routes.set_route_mode("image", "gpt-image-2", "round_robin")
    route = _route("image", "gpt-image-2")
    for _ in range(3):
        assert model_routes.route_preview(route)[1] == "Tuzi"
    def select(_):
        order = []
        key, _ = model_routes.resolve_auto("image", "gpt-image-2", route_order=order)
        assert order[0] == key.alias and len(set(order)) == 3
        return key.alias
    with ThreadPoolExecutor(max_workers=6) as pool:
        assert Counter(pool.map(select, range(30))) == {"Tuzi": 10, "HK": 10, "OpenRouter": 10}
    order = []
    model_routes.resolve_auto("image", "gpt-image-2", route_order=order)
    model_routes.set_route_order("image", "gpt-image-2", ["OpenRouter", "HK", "Tuzi"])
    model_routes.set_route_mode("image", "gpt-image-2", "order")
    assert model_routes.next_member("image", "gpt-image-2", ["Tuzi"], route_order=order)[0].alias == "HK"
    keys.patch_key("HK", {"enabled": False})
    assert model_routes.next_member("image", "gpt-image-2", ["Tuzi"], route_order=order)[0].alias == "OpenRouter"


def test_cheap_uses_actual_params_unknown_last_and_freezes(monkeypatch):
    _seed()
    model_routes.set_route_mode("image", "gpt-image-2", "cheap")
    seen = []
    def estimate(member, modality, params):
        seen.append((member.alias, modality, params))
        return {"Tuzi": params["n"] * 2, "HK": 3, "OpenRouter": None}[member.alias]
    monkeypatch.setattr(model_routes, "member_estimate", estimate)
    order = []
    params = {"n": 2, "reference_images": ["one", "two"]}
    assert model_routes.resolve_auto("image", "gpt-image-2", params=params, route_order=order)[0].alias == "HK"
    assert order == ["HK", "Tuzi", "OpenRouter"]
    assert all(item[2] == params for item in seen)
    assert model_routes.next_member("image", "gpt-image-2", ["HK"], route_order=order)[0].alias == "Tuzi"


def test_route_mode_api_default_storage_and_candidate(client):
    _seed()
    body = {"modality": "image", "id": "gpt-image-2", "mode": "round_robin"}
    response = client.put("/api/models/mode", json=body)
    assert response.status_code == 200
    assert response.json()["mode"] == "round_robin"
    assert response.json()["candidate_alias"] == "Tuzi"
    assert keys.read_keys_db().route_mode == {"image": {"gpt-image-2": "round_robin"}}
    assert client.put("/api/models/mode", json={**body, "mode": "bad"}).status_code == 422
    assert client.put("/api/models/mode", json={**body, "mode": "order"}).status_code == 200
    assert keys.read_keys_db().route_mode == {}


def test_preview_real_static_prices_use_default_generation_params():
    from character_workflow.lib.generation_pricing import estimate_submission
    keys.write_keys_db(keys.KeysDB.model_validate({"keys": [
        _key("Ark", "seedream", [{"id": "doubao-seedream-4-5-251128", "name": "Seedream", "modality": "image"}]),
        _key("Video", "seedance", [{"id": "doubao-seedance-1-0-pro-250528", "name": "Seedance", "modality": "video", "protocol": "seedance"}]),
    ]}))
    for route in model_routes.list_routes():
        model_routes.set_route_mode(route.modality, route.id, "cheap")
        route = model_routes.find_route(route.modality, route.id)
        members, candidate, estimates = model_routes.route_preview(route)
        assert candidate == members[0].alias
        value = estimates[candidate]
        assert value is not None and value > 0
        key = keys.find_by_alias(candidate)
        params = {"n": 1} if route.modality == "image" else {"n": 1, "duration": 5, "resolution": "720p", "ratio": "16:9"}
        assert value == estimate_submission(key, members[0].model_id, route.modality, params)


@pytest.mark.parametrize("disable", [False, True])
def test_batch_confirmation_consumes_once_and_rejects_missing_route_without_active_pointer(tmp_path, monkeypatch, disable):
    from character_workflow.lib import canvas_batches as batches
    from character_workflow.lib.atomic_io import atomic_write_json
    from character_workflow.lib.schemas import CanvasDocument

    _seed()
    model_routes.set_route_mode("image", "gpt-image-2", "round_robin")
    order = []
    model_routes.resolve_auto("image", "gpt-image-2", consume=False, route_order=order)
    document = CanvasDocument(project_id="project", updated_at="2026-10-25")
    monkeypatch.setattr(batches, "canvas_project_dir", lambda _: tmp_path)
    monkeypatch.setattr(batches, "canvas_project_lock_path", lambda _: tmp_path / "project.lock")
    monkeypatch.setattr(batches, "_read_document_unlocked", lambda _: document)
    run = batches.CanvasBatchRun(batch_id="batch-" + "a" * 24, project_id="project",
        scope_node_id="scope", title="Batch", expected_revision=0, repeat_count=1,
        items=[], steps=[], executions=[], status="ready", created_at="now", updated_at="now")
    batches._save(run)
    plan = batches.CanvasBatchPlan(document=document, model_signatures={}, route_snapshots={
        "step": {"modality": "image", "route_id": "gpt-image-2", "route_order": order, "mode": "round_robin"},
    })
    atomic_write_json(batches._path("project", run.batch_id, plan=True), plan.model_dump(mode="json"))
    if disable:
        for alias in order:
            keys.patch_key(alias, {"enabled": False})
        with pytest.raises(ValueError, match="重新确认"):
            batches.start_canvas_batch("project", run.batch_id)
        assert not (tmp_path / ".runtime" / "batch-active.json").exists()
        assert batches.read_canvas_batch("project", run.batch_id).status == "ready"
    else:
        assert model_routes.route_preview(_route("image", "gpt-image-2"))[1] == "Tuzi"
        assert batches.start_canvas_batch("project", run.batch_id)[1] is True
        assert batches.start_canvas_batch("project", run.batch_id)[1] is False
        assert model_routes.route_preview(_route("image", "gpt-image-2"))[1] == "HK"
        stored = batches.CanvasBatchPlan.model_validate_json(batches._path("project", run.batch_id, plan=True).read_text())
        assert stored.route_snapshots["step"]["route_order"] == ["Tuzi", "HK", "OpenRouter"]
