from __future__ import annotations

import pytest

from character_workflow.lib import canvas_runs
from character_workflow.lib.canvas_runs import (
    _commit_frozen_run,
    _render_final_prompt,
    _resolve_inputs,
    submit_canvas_run,
)
from character_workflow.lib.keys import KeySpec, ModelSpec
from character_workflow.lib.schemas import CanvasDocument, JobKind, JobParams


NOW = "2026-08-25T00:00:00Z"


def _document(prompt: str, *, policy: str = "mentions_only") -> CanvasDocument:
    nodes = [
        {
            "id": "image-a",
            "title": "图片 A",
            "type": "image",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": "version-image-a",
                "generation_draft": None,
                "active_run_id": None,
                "display": {"fit": "contain", "free_resize": False},
            },
        },
        {
            "id": "text-a",
            "title": "文本 A",
            "type": "text",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": "version-text-a",
                "generation_draft": None,
                "active_run_id": None,
            },
        },
        {
            "id": "image-b",
            "title": "图片 B",
            "type": "image",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": "version-image-b",
                "generation_draft": None,
                "active_run_id": None,
                "display": {"fit": "contain", "free_resize": False},
            },
        },
        {
            "id": "config",
            "title": "生成",
            "type": "config",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "draft": {
                    "mode": "image",
                    "prompt": prompt,
                    "input_policy": policy,
                    "model": "gpt-image-2",
                    "alias": "openai",
                    "params": {},
                    "updated_at": NOW,
                }
            },
        },
    ]
    connections = [
        {"id": "edge-image-a", "role": "input", "source_node_id": "image-a", "target_node_id": "config"},
        {"id": "edge-text-a", "role": "input", "source_node_id": "text-a", "target_node_id": "config"},
        {"id": "edge-image-b", "role": "input", "source_node_id": "image-b", "target_node_id": "config"},
    ]
    versions = {
        "version-image-a": {
            "version_id": "version-image-a",
            "kind": "image",
            "path": "uploads/image-a.png",
            "mime_type": "image/png",
            "bytes": 12,
            "created_at": NOW,
            "sha256": "a" * 64,
            "origin": {"kind": "upload", "upload_id": "image-a"},
        },
        "version-text-a": {
            "version_id": "version-text-a",
            "kind": "text",
            "text": "一列火车驶入雨夜",
            "created_at": NOW,
            "sha256": "b" * 64,
            "origin": {"kind": "user_edit"},
        },
        "version-image-b": {
            "version_id": "version-image-b",
            "kind": "image",
            "path": "uploads/image-b.png",
            "mime_type": "image/png",
            "bytes": 12,
            "created_at": NOW,
            "sha256": "c" * 64,
            "origin": {"kind": "upload", "upload_id": "image-b"},
        },
    }
    return CanvasDocument.model_validate({
        "schema_version": 2,
        "project_id": "canvas-test",
        "revision": 3,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "settings": {"background": "dots", "show_image_info": True, "show_minimap": True},
        "nodes": nodes,
        "connections": connections,
        "content_versions": versions,
        "updated_at": NOW,
    })


def test_mentions_only_freezes_prompt_order_and_renumbers_each_media_kind():
    prompt = (
        "让 @[node:image-b] 延续 @[node:text-a] 的叙事，再参考 @[node:image-a]，"
        "最后回到 @[node:image-b]"
    )
    document = _document(prompt)
    surface = next(node for node in document.nodes if node.id == "config")
    draft = surface.data.draft

    inputs = _resolve_inputs(document, surface, draft)
    final_prompt = _render_final_prompt(document, draft, inputs)

    assert [item.node_id for item in inputs] == ["image-b", "text-a", "image-a"]
    assert [item.order for item in inputs] == [0, 1, 2]
    assert "让 图片1 延续 【文本1】 的叙事，再参考 图片2，最后回到 图片1" in final_prompt
    assert "参考素材编号：图片1、图片2" in final_prompt
    assert "【文本1】\n一列火车驶入雨夜" in final_prompt
    assert "@[node:" not in final_prompt


def test_all_connected_keeps_unmentioned_inputs_after_mentions_and_labels_actual_order():
    document = _document("以 @[node:image-b] 为主", policy="all_connected")
    surface = next(node for node in document.nodes if node.id == "config")
    draft = surface.data.draft

    inputs = _resolve_inputs(document, surface, draft)
    final_prompt = _render_final_prompt(document, draft, inputs)

    assert [item.node_id for item in inputs] == ["image-b", "image-a", "text-a"]
    assert "以 图片1 为主" in final_prompt
    assert "参考素材编号：图片1、图片2" in final_prompt
    assert "【文本1】\n一列火车驶入雨夜" in final_prompt


def test_disconnected_mention_is_rejected_instead_of_becoming_plain_text():
    document = _document("参考 @[node:image-a]")
    document.connections = [
        edge for edge in document.connections if edge.source_node_id != "image-a"
    ]
    surface = next(node for node in document.nodes if node.id == "config")

    with pytest.raises(ValueError, match="未连接"):
        _resolve_inputs(document, surface, surface.data.draft)


def test_existing_text_surface_includes_its_implicit_current_version():
    document = _document("把原文改成更克制的旁白")
    surface = next(node for node in document.nodes if node.id == "text-a")
    config = next(node for node in document.nodes if node.id == "config")
    surface.data.generation_draft = config.data.draft.model_copy(update={
        "mode": "text",
        "prompt": "把原文改成更克制的旁白",
        "input_policy": "all_connected",
    })

    inputs = _resolve_inputs(document, surface, surface.data.generation_draft)
    final_prompt = _render_final_prompt(document, surface.data.generation_draft, inputs)

    assert [(item.source, item.node_id) for item in inputs] == [("implicit_self", "text-a")]
    assert "参考文本：\n【文本1】\n一列火车驶入雨夜" in final_prompt


def test_existing_image_keeps_implicit_self_as_first_reference_when_mentioning_an_input():
    document = _document("让 @[node:image-b] 延续原图")
    surface = next(node for node in document.nodes if node.id == "image-a")
    config = next(node for node in document.nodes if node.id == "config")
    surface.data.generation_draft = config.data.draft.model_copy(update={
        "prompt": "让 @[node:image-b] 延续原图",
        "input_policy": "all_connected",
    })
    document.connections.append(document.connections[-1].model_copy(update={
        "id": "edge-image-b-to-image-a",
        "target_node_id": "image-a",
    }))

    inputs = _resolve_inputs(document, surface, surface.data.generation_draft)
    final_prompt = _render_final_prompt(document, surface.data.generation_draft, inputs)

    assert [(item.source, item.node_id) for item in inputs] == [
        ("implicit_self", "image-a"),
        ("input_connection", "image-b"),
    ]
    assert "参考素材编号：图片1、图片2" in final_prompt
    assert "让 图片2 延续原图" in final_prompt


def test_submit_keeps_snapshot_labels_and_all_job_media_arrays_in_frozen_order(
    monkeypatch,
    tmp_path,
):
    document = _document(
        "让 @[node:video-a] 对照 @[node:image-b]，听 @[node:audio-a]，再看 @[node:image-a]"
    )
    payload = document.model_dump(mode="json")
    payload["nodes"].extend([
        {
            "id": "video-a",
            "title": "视频 A",
            "type": "video",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": "version-video-a",
                "generation_draft": None,
                "active_run_id": None,
                "display": {"fit": "contain", "free_resize": False},
            },
        },
        {
            "id": "audio-a",
            "title": "音频 A",
            "type": "audio",
            "position": {"x": 0, "y": 0},
            "z_index": 0,
            "data": {
                "current_version_id": "version-audio-a",
                "generation_draft": None,
                "active_run_id": None,
            },
        },
    ])
    payload["connections"].extend([
        {
            "id": "edge-video-a",
            "role": "input",
            "source_node_id": "video-a",
            "target_node_id": "config",
        },
        {
            "id": "edge-audio-a",
            "role": "input",
            "source_node_id": "audio-a",
            "target_node_id": "config",
        },
    ])
    payload["content_versions"].update({
        "version-video-a": {
            "version_id": "version-video-a",
            "kind": "video",
            "path": "uploads/video-a.mp4",
            "mime_type": "video/mp4",
            "bytes": 12,
            "created_at": NOW,
            "sha256": "d" * 64,
            "origin": {"kind": "upload", "upload_id": "video-a"},
        },
        "version-audio-a": {
            "version_id": "version-audio-a",
            "kind": "audio",
            "path": "uploads/audio-a.wav",
            "mime_type": "audio/wav",
            "bytes": 12,
            "created_at": NOW,
            "sha256": "e" * 64,
            "origin": {"kind": "upload", "upload_id": "audio-a"},
        },
    })
    document = CanvasDocument.model_validate(payload)

    for relative_path in (
        "uploads/image-a.png",
        "uploads/image-b.png",
        "uploads/video-a.mp4",
        "uploads/audio-a.wav",
    ):
        target = tmp_path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"content")

    key = KeySpec(
        alias="canvas-test",
        provider="seedance",
        access_key="secret",
        models=[],
        created_at=NOW,
    )
    model = ModelSpec(
        name="Seedance",
        id="seedance-2.0",
        modality="video",
        protocol="seedance",
    )
    captured = {}

    monkeypatch.setattr(canvas_runs, "canvas_project_dir", lambda _project_id: tmp_path)
    monkeypatch.setattr(canvas_runs, "_lock_path", lambda _project_id: tmp_path / "canvas.lock")
    monkeypatch.setattr(canvas_runs, "recover_canvas_transactions_unlocked", lambda _project_id: None)
    monkeypatch.setattr(canvas_runs, "_read_document_unlocked", lambda _project_id: document)
    monkeypatch.setattr(canvas_runs, "_resolve_key_and_model", lambda _draft: (key, model, JobKind.VIDEO))
    monkeypatch.setattr(
        canvas_runs,
        "_normalized_params",
        lambda _draft, _count, _key, _model: ({}, JobParams(), 1),
    )
    monkeypatch.setattr(canvas_runs, "_validate_input_capabilities", lambda *_args: None)

    def capture_commit(*_args, **kwargs):
        captured.update(kwargs)
        return None, document

    monkeypatch.setattr(canvas_runs, "_commit_frozen_run", capture_commit)
    submit_canvas_run(document.project_id, "config", document.revision)

    assert [item.node_id for item in captured["inputs"]] == [
        "video-a",
        "image-b",
        "audio-a",
        "image-a",
    ]
    assert "让 视频1 对照 图片1，听 音频1，再看 图片2" in captured["final_prompt"]
    params = captured["job_params"]
    assert params.reference_images == [
        str(tmp_path / "uploads/image-b.png"),
        str(tmp_path / "uploads/image-a.png"),
    ]
    assert params.reference_videos == [str(tmp_path / "uploads/video-a.mp4")]
    assert params.reference_audios == [str(tmp_path / "uploads/audio-a.wav")]


def test_config_video_commit_creates_downstream_video_with_derivation(monkeypatch):
    document = _document("把 @[node:text-a] 做成一段雨夜列车镜头")
    surface = next(node for node in document.nodes if node.id == "config")
    draft = surface.data.draft.model_copy(update={
        "mode": "video",
        "model": "seedance-2.0",
        "alias": "seedance",
        "params": JobParams(duration=5, resolution="720p", ratio="16:9"),
    })
    surface.data.draft = draft
    inputs = _resolve_inputs(document, surface, draft)
    key = KeySpec(
        alias="seedance",
        provider="seedance",
        access_key="secret",
        models=[],
        created_at=NOW,
    )
    model = ModelSpec(
        name="Seedance",
        id="seedance-2.0",
        modality="video",
        protocol="seedance",
    )
    monkeypatch.setattr(canvas_runs, "_commit_transaction_unlocked", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(canvas_runs, "_now", lambda: NOW)

    job, updated = _commit_frozen_run(
        document.project_id,
        document,
        surface,
        key,
        model,
        JobKind.VIDEO,
        mode="video",
        final_prompt=_render_final_prompt(document, draft, inputs),
        input_policy=draft.input_policy,
        normalized={"duration": 5, "resolution": "720p", "ratio": "16:9"},
        job_params=JobParams(duration=5, resolution="720p", ratio="16:9"),
        inputs=inputs,
        requested_count=1,
        result_title="生成视频",
        result_draft=draft,
        allow_surface_reuse=True,
        transaction_kind="submit",
        run_id="run-video",
    )

    assert job.kind == JobKind.VIDEO
    assert job.canvas_run is not None
    assert job.canvas_run.snapshot.mode == "video"
    assert job.canvas_run.snapshot.surface_node_id == "config"
    result = next(node for node in updated.nodes if node.id == job.canvas_run.result_node_id)
    assert result.type == "video"
    assert result.data.active_run_id == "run-video"
    assert any(
        edge.role == "derivation"
        and edge.source_node_id == "config"
        and edge.target_node_id == result.id
        and edge.origin.run_id == "run-video"
        for edge in updated.connections
    )
