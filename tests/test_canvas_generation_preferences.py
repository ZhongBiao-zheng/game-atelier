import json

from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib import data_root
from character_workflow.lib.canvas_runs import _resolve_default_image_model
from character_workflow.lib.keys import KeySpec, KeysDB, ModelSpec, write_keys_db
from viewer_server.server_app import build_app


def _client(isolated_data_root) -> TestClient:
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _payload(revision: int = 0) -> dict:
    return {
        "expected_revision": revision,
        "image_toolbar": {
            "tool_ids": ["info", "download"],
            "show_labels": True,
        },
        "generation_defaults": {
            "text": {
                "selection": {"alias": "text-main", "model": "gpt-5"},
                "params": {"n": 2, "reasoning_effort": "high"},
            },
            "image": {
                "selection": {"alias": "image-main", "model": "gpt-image-2"},
                "params": {"n": 3, "ratio": "16:9", "quality": "high"},
            },
            "video": {
                "selection": {"alias": "video-main", "model": "seedance-2.0"},
                "params": {
                    "duration": 8,
                    "ratio": "16:9",
                    "resolution": "720p",
                    "frame_mode": "auto",
                    "generate_audio": True,
                    "watermark": False,
                },
            },
            "audio": {
                "selection": {"alias": "audio-main", "model": "gpt-4o-mini-tts"},
                "params": {
                    "voice": "coral",
                    "response_format": "wav",
                    "speed": 1.25,
                    "instructions": "平静、克制",
                },
            },
        },
    }


def test_generation_preferences_default_get_is_v2_and_does_not_write(isolated_data_root):
    client = _client(isolated_data_root)

    response = client.get("/api/canvas/ui-preferences")

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 2,
        "revision": 0,
        "image_toolbar": {
            "tool_ids": [
                "info", "delete", "saveAsset", "download", "copyPrompt", "reversePrompt",
                "replace", "maskEdit", "crop", "split", "upscale",
            ],
            "show_labels": False,
        },
        "generation_defaults": {
            mode: {"selection": None, "params": {}}
            for mode in ("text", "image", "video", "audio")
        },
        "updated_at": None,
    }
    assert not data_root.canvas_ui_file().exists()


def test_generation_preferences_save_atomically_and_reject_stale_revision(isolated_data_root):
    client = _client(isolated_data_root)

    saved = client.put("/api/canvas/ui-preferences", json=_payload())

    assert saved.status_code == 200
    assert saved.json()["revision"] == 1
    assert saved.json()["generation_defaults"]["audio"]["params"] == {
        "voice": "coral",
        "response_format": "wav",
        "speed": 1.25,
        "instructions": "平静、克制",
    }
    original = data_root.canvas_ui_file().read_bytes()

    stale = client.put("/api/canvas/ui-preferences", json=_payload())

    assert stale.status_code == 409
    assert stale.json()["detail"] == {"code": "revision_conflict", "current_revision": 1}
    assert data_root.canvas_ui_file().read_bytes() == original


def test_generation_preferences_reject_unsafe_or_cross_modality_params(isolated_data_root):
    client = _client(isolated_data_root)
    unsafe = _payload()
    unsafe["generation_defaults"]["image"]["params"]["reference_images"] = ["/tmp/a.png"]
    cross_modality = _payload()
    cross_modality["generation_defaults"]["audio"]["params"]["ratio"] = "16:9"

    assert client.put("/api/canvas/ui-preferences", json=unsafe).status_code == 422
    assert client.put("/api/canvas/ui-preferences", json=cross_modality).status_code == 422
    assert not data_root.canvas_ui_file().exists()


def test_generation_preferences_reject_paths_disguised_as_option_values(isolated_data_root):
    client = _client(isolated_data_root)
    image_path = _payload()
    image_path["generation_defaults"]["image"]["params"]["size"] = "/tmp/private.png"
    video_path = _payload()
    video_path["generation_defaults"]["video"]["params"]["ratio"] = r"C:\\private.mp4"

    assert client.put("/api/canvas/ui-preferences", json=image_path).status_code == 422
    assert client.put("/api/canvas/ui-preferences", json=video_path).status_code == 422
    assert not data_root.canvas_ui_file().exists()


def test_generation_preferences_do_not_silently_accept_v1_or_corrupt_files(isolated_data_root):
    client = _client(isolated_data_root)
    path = data_root.canvas_ui_file()
    legacy = {
        "schema_version": 1,
        "revision": 4,
        "image_toolbar": {"tool_ids": ["info"], "show_labels": False},
        "updated_at": None,
    }
    path.write_text(json.dumps(legacy), encoding="utf-8")
    original = path.read_bytes()

    response = client.get("/api/canvas/ui-preferences")

    assert response.status_code == 409
    assert path.read_bytes() == original


def test_reverse_prompt_recovery_uses_saved_routable_image_default(isolated_data_root):
    write_keys_db(KeysDB(default_alias="fallback", keys=[
        KeySpec(
            alias="fallback",
            provider="openai",
            access_key="secret",
            created_at="2026-08-25T00:00:00Z",
            models=[ModelSpec(name="Fallback", id="gpt-image-1", modality="image")],
        ),
        KeySpec(
            alias="preferred",
            provider="tokendance",
            base_url="https://api.tokendance.example/gateway/v1",
            access_key="secret",
            created_at="2026-08-25T00:00:00Z",
            models=[ModelSpec(
                name="Preferred",
                id="seedream-5.0-pro",
                modality="image",
                protocol="ark",
            )],
        ),
    ]))
    payload = _payload()
    payload["generation_defaults"]["image"] = {
        "selection": {"alias": "preferred", "model": "seedream-5.0-pro"},
        "params": {"n": 2, "ratio": "9:16", "resolution": "2K"},
    }
    assert _client(isolated_data_root).put(
        "/api/canvas/ui-preferences", json=payload
    ).status_code == 200

    key, model, params = _resolve_default_image_model()

    assert (key.alias, model.id) == ("preferred", "seedream-5.0-pro")
    assert params.model_dump(exclude_none=True) == {"n": 2, "ratio": "9:16", "resolution": "2K"}


def test_reverse_prompt_recovery_falls_back_without_leaking_stale_params(isolated_data_root):
    write_keys_db(KeysDB(default_alias="stub", keys=[
        KeySpec(
            alias="stub",
            provider="nano_banana",
            access_key="secret",
            created_at="2026-08-25T00:00:00Z",
            models=[ModelSpec(name="Stub", id="nano-banana-pro", modality="image")],
        ),
        KeySpec(
            alias="fallback",
            provider="openai",
            access_key="secret",
            created_at="2026-08-25T00:00:00Z",
            models=[ModelSpec(name="Fallback", id="gpt-image-1", modality="image")],
        ),
    ]))
    payload = _payload()
    payload["generation_defaults"]["image"] = {
        "selection": {"alias": "removed", "model": "removed-model"},
        "params": {"n": 4, "ratio": "9:16", "quality": "high"},
    }
    assert _client(isolated_data_root).put(
        "/api/canvas/ui-preferences", json=payload
    ).status_code == 200

    key, model, params = _resolve_default_image_model()

    assert (key.alias, model.id) == ("fallback", "gpt-image-1")
    assert params.model_dump(exclude_none=True) == {"n": 1, "ratio": "1:1"}


def test_reverse_prompt_recovery_applies_auto_model_params(isolated_data_root):
    write_keys_db(KeysDB(default_alias="fallback", keys=[
        KeySpec(
            alias="fallback",
            provider="openai",
            access_key="secret",
            created_at="2026-08-25T00:00:00Z",
            models=[ModelSpec(name="Fallback", id="gpt-image-1", modality="image")],
        ),
    ]))
    payload = _payload()
    payload["generation_defaults"]["image"] = {
        "selection": None,
        "params": {
            "n": 3,
            "ratio": "16:9",
            "size": "4096x4096",
            "quality": "high",
        },
    }
    assert _client(isolated_data_root).put(
        "/api/canvas/ui-preferences", json=payload
    ).status_code == 200

    key, model, params = _resolve_default_image_model()

    assert (key.alias, model.id) == ("fallback", "gpt-image-1")
    assert params.model_dump(exclude_none=True) == {
        "n": 3,
        "ratio": "16:9",
        "size": "2880x2880",
        "quality": "high",
    }


def test_reverse_prompt_recovery_normalizes_auto_params_for_selected_model(isolated_data_root):
    write_keys_db(KeysDB(default_alias="fallback", keys=[
        KeySpec(
            alias="fallback",
            provider="tokendance",
            access_key="secret",
            created_at="2026-08-25T00:00:00Z",
            models=[ModelSpec(
                name="Fallback",
                id="seedream-5.0-pro",
                modality="image",
                protocol="ark",
            )],
        ),
    ]))
    payload = _payload()
    payload["generation_defaults"]["image"] = {
        "selection": None,
        "params": {
            "n": 3,
            "ratio": "16:9",
            "resolution": "4K",
            "size": "2048x2048",
            "quality": "high",
            "background": "transparent",
        },
    }
    assert _client(isolated_data_root).put(
        "/api/canvas/ui-preferences", json=payload
    ).status_code == 200

    _, _, params = _resolve_default_image_model()

    assert params.model_dump(exclude_none=True) == {
        "n": 3,
        "ratio": "16:9",
        "resolution": "2K",
        "size": "2048x2048",
    }
