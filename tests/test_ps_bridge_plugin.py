"""PS 联动插件（ps-bridge）第 1 批：状态、取图、发回。CI 不碰真实 Photoshop，执行器换成假实现。

`.jsx` 在真实 PS 里的行为见插件 README 的真机清单。
"""
from __future__ import annotations

import io
import os
import sys
import time
from pathlib import Path

import pytest
from PIL import Image

from character_workflow.lib import plugin_registry, plugin_server
from character_workflow.lib.canvas_agent_tools import _media_node
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.schemas import CanvasDocument
from tests.local_client import LocalTestClient as TestClient
from viewer_server.server_app import build_app

PLUGIN_ID = "ps-bridge"
DOCUMENT = {"id": 7, "name": "海报.psd", "path": "/作品/海报.psd", "width": 4000, "height": 3000}


def _png(size=(40, 20), color=(200, 30, 30, 255), mode="RGBA", fmt="PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, size, color if mode == "RGBA" else color[:3]).save(buffer, fmt)
    return buffer.getvalue()


class FakePhotoshop:
    """记录每次调用的配置；按动作写出产物、返回回执。"""

    def __init__(self, bridge) -> None:
        self.bridge = bridge
        self.is_running = True
        self.calls: list[dict] = []
        self.export_bytes = _png()
        self.selection: list | None = [100, 200, 140, 220]
        self.placed: dict | None = None
        self.failure = None

    def running(self) -> bool:
        return self.is_running

    def installed(self) -> bool:
        return True

    def call(self, request_dir: Path, config: dict, timeout_s: int) -> dict:
        assert Path(config["result"]).parent == request_dir and Path(config["cancel"]).parent == request_dir
        self.calls.append(dict(config))
        if not self.is_running:
            raise self.bridge.PsError("PS_NOT_RUNNING", "Photoshop 未启动", 409)
        if self.failure is not None:
            return self.failure
        if config["action"] == "version":
            return {"ok": True, "version": "26.0.0", "active_document": DOCUMENT["name"]}
        if config["action"] == "import":
            assert Path(config["out_png"]).parent == request_dir
            Path(config["out_png"]).write_bytes(self.export_bytes)
            return {"ok": True, "document": DOCUMENT, "selection": self.selection, "scope": config["scope"],
                    "layer": "角色 图层" if config["scope"] == "layer" else None}
        if config["action"] == "place":
            png = Path(config["png"])
            assert png.parent == request_dir
            with Image.open(png) as image:
                self.placed = {**config, "format": image.format, "size": image.size}
            return {"ok": True, "target": {"name": (config["target"] or {}).get("name") or "未命名-1"}}
        raise AssertionError(config["action"])


@pytest.fixture
def ps(isolated_data_root, monkeypatch):
    plugin_registry.set_enabled(PLUGIN_ID, True)
    record = plugin_registry.find(PLUGIN_ID)
    assert record is not None and plugin_registry.is_host(record)
    plugin_server._api(record)
    bridge = sys.modules[f"{plugin_server._module_name(PLUGIN_ID)}.bridge"]
    fake = FakePhotoshop(bridge)
    monkeypatch.setattr(bridge, "EXECUTOR", fake)
    monkeypatch.setattr(bridge, "responsible_app", lambda: "Atelier")
    yield fake
    plugin_server.unload(PLUGIN_ID)


def call(project_id: str, path: str, params: dict | None = None) -> dict:
    result, _ = plugin_server.call(PLUGIN_ID, "POST", path, project_id=project_id, origin="host", params=params)
    return result


def refuse(project_id: str, path: str, params: dict | None = None) -> plugin_server.PluginError:
    with pytest.raises(plugin_server.PluginError) as error:
        call(project_id, path, params)
    return error.value


def add_image(project_id: str, node_id: str, data: bytes, ext: str = "png") -> str:
    document = read_canvas_document(project_id)
    version, _, _ = save_canvas_upload(
        project_id, f"{node_id}.{ext}", ext, data, "image", document.revision,
        node_factory=lambda v: _media_node("image", node_id, f"标题 {node_id}", {"x": 0, "y": 0}, v.version_id))
    return version.version_id


def connect(project_id: str, *pairs: tuple[str, str]) -> None:
    document = read_canvas_document(project_id)
    raw = document.model_dump(mode="json")
    raw["connections"].extend({"id": f"c-{source}-{target}", "role": "input", "source_node_id": source,
                               "target_node_id": target} for source, target in pairs)
    save_canvas_document(project_id, CanvasDocument.model_validate(raw), document.revision)


def requests_left(ps) -> list[Path]:
    root = ps.bridge.requests_root()
    return sorted(root.iterdir()) if root.exists() else []


def test_ps_bridge_is_a_host_plugin_that_ships_disabled(isolated_data_root):
    record = plugin_registry.find(PLUGIN_ID)
    assert record is not None and record.availability == "ok" and plugin_registry.is_host(record)
    assert PLUGIN_ID not in plugin_registry.enabled_ids()


# ── 状态 ─────────────────────────────────────────────────────────────


def test_status_without_probe_does_not_talk_to_photoshop(ps):
    project_id = create_canvas_project("PS").project_id
    assert call(project_id, "/status") == {
        "supported": True, "installed": True, "running": True, "responsible_app": "Atelier",
        "version": None, "active_document": None}
    assert ps.calls == []


def test_status_probe_reads_version_and_active_document(ps):
    project_id = create_canvas_project("PS").project_id
    status = call(project_id, "/status", {"probe": True})
    assert status["version"] == "26.0.0" and status["active_document"] == "海报.psd"
    assert [item["action"] for item in ps.calls] == ["version"]


def test_status_probe_while_photoshop_is_closed_does_not_call_it(ps):
    ps.is_running = False
    project_id = create_canvas_project("PS").project_id
    assert call(project_id, "/status", {"probe": True})["running"] is False
    assert ps.calls == []


# ── 取图 ─────────────────────────────────────────────────────────────


def test_import_lands_a_plain_image_node_and_remembers_where_it_came_from(ps):
    project_id = create_canvas_project("PS").project_id
    result = call(project_id, "/import", {"scope": "merged"})
    assert result["title"] == "海报 · 选区"
    node = next(item for item in read_canvas_document(project_id).nodes if item.id == result["node_id"])
    assert node.type == "image" and node.title == "海报 · 选区"
    state = plugin_server._read_plugin_state(project_id, PLUGIN_ID).data
    origin = state["origins"][node.data.current_version_id]
    assert origin["document"] == DOCUMENT and origin["bounds"] == [100, 200, 140, 220]
    assert origin["scope"] == "merged" and origin["layer"] is None
    assert requests_left(ps) == [], "请求目录用完即删"


def test_import_of_the_current_layer_names_the_node_after_the_layer(ps):
    project_id = create_canvas_project("PS").project_id
    assert call(project_id, "/import", {"scope": "layer"})["title"] == "海报 · 角色 图层"
    assert ps.calls[0]["scope"] == "layer"


def test_import_without_a_selection_takes_the_whole_document(ps):
    ps.selection = None
    project_id = create_canvas_project("PS").project_id
    result = call(project_id, "/import")
    assert result["title"] == "海报"
    version_id = next(item for item in read_canvas_document(project_id).nodes
                      if item.id == result["node_id"]).data.current_version_id
    origin = plugin_server._read_plugin_state(project_id, PLUGIN_ID).data["origins"][version_id]
    assert origin["bounds"] == [0, 0, 4000, 3000]


def test_import_while_photoshop_is_closed_says_so(ps):
    ps.is_running = False
    project_id = create_canvas_project("PS").project_id
    error = refuse(project_id, "/import")
    assert (error.code, error.status, error.message) == ("PS_NOT_RUNNING", 409, "Photoshop 未启动")
    assert read_canvas_document(project_id).nodes == [] and requests_left(ps) == []


def test_import_refuses_an_export_that_is_not_png(ps):
    ps.export_bytes = _png(fmt="JPEG", mode="RGB")
    project_id = create_canvas_project("PS").project_id
    error = refuse(project_id, "/import")
    assert error.code == "PS_FAILED" and "不是 PNG" in error.message
    assert read_canvas_document(project_id).nodes == []


def test_import_never_follows_a_link_out_of_the_request_directory(ps, tmp_path, monkeypatch):
    outside = tmp_path / "keys.png"
    outside.write_bytes(_png())
    original = ps.call

    def link_instead(request_dir, config, timeout_s):
        receipt = original(request_dir, config, timeout_s)
        Path(config["out_png"]).unlink()
        os.symlink(outside, config["out_png"])
        return receipt

    monkeypatch.setattr(ps, "call", link_instead)
    project_id = create_canvas_project("PS").project_id
    error = refuse(project_id, "/import")
    assert error.code == "PS_FAILED" and read_canvas_document(project_id).nodes == []


@pytest.mark.parametrize(("path", "params"), [
    ("/import", {"scope": "merged", "out_png": "/tmp/x.png"}),
    ("/import", {"scope": "everything"}),
    ("/place", {"node_id": "image-1", "png": "/etc/passwd"}),
    ("/status", {"probe": True, "script": "app.quit()"}),
])
def test_routes_take_no_paths_or_scripts_from_the_request(ps, path, params):
    project_id = create_canvas_project("PS").project_id
    assert refuse(project_id, path, params).status == 422
    assert ps.calls == []


def test_only_one_photoshop_request_runs_at_a_time(ps):
    project_id = create_canvas_project("PS").project_id
    assert ps.bridge._busy.acquire(blocking=False)
    try:
        error = refuse(project_id, "/import")
    finally:
        ps.bridge._busy.release()
    assert (error.code, error.status) == ("PS_BUSY", 409) and "上一个请求" in error.message
    assert ps.calls == []


def test_import_works_through_the_http_route(ps):
    project_id = create_canvas_project("PS").project_id
    client = TestClient(base_url="http://127.0.0.1", app=build_app())
    response = client.post(f"/api/plugins/{PLUGIN_ID}/routes/import",
                           json={"project_id": project_id, "params": {"scope": "merged"}})
    assert response.status_code == 200, response.text
    assert response.json()["result"]["title"] == "海报 · 选区"


# ── 发回 ─────────────────────────────────────────────────────────────


def test_place_returns_an_imported_image_to_its_document_and_bounds(ps):
    project_id = create_canvas_project("PS").project_id
    node_id = call(project_id, "/import")["node_id"]
    result = call(project_id, "/place", {"node_id": node_id})
    assert result == {"document": "海报.psd", "layer": "海报 · 选区", "returned_to_origin": True}
    assert ps.placed["target"] == {"doc_id": 7, "name": "海报.psd", "path": "/作品/海报.psd", "strict": True}
    assert ps.placed["bounds"] == [100, 200, 140, 220] and ps.placed["layer_name"] == "海报 · 选区"


def test_a_result_generated_from_one_imported_image_goes_back_to_the_same_place(ps):
    project_id = create_canvas_project("PS").project_id
    source = call(project_id, "/import")["node_id"]
    add_image(project_id, "image-result", _png((80, 40)))
    connect(project_id, (source, "image-result"))
    assert call(project_id, "/place", {"node_id": "image-result"})["returned_to_origin"] is True
    assert ps.placed["bounds"] == [100, 200, 140, 220] and ps.placed["target"]["name"] == "海报.psd"


def test_two_imported_inputs_are_ambiguous_so_the_image_goes_to_the_active_document(ps):
    project_id = create_canvas_project("PS").project_id
    first = call(project_id, "/import")["node_id"]
    ps.selection = [0, 0, 10, 10]
    second = call(project_id, "/import")["node_id"]
    add_image(project_id, "image-result", _png())
    connect(project_id, (first, "image-result"), (second, "image-result"))
    result = call(project_id, "/place", {"node_id": "image-result"})
    assert result["returned_to_origin"] is False
    assert ps.placed["target"] is None and ps.placed["bounds"] is None


def test_place_converts_any_image_to_png_and_measures_its_opaque_content(ps):
    project_id = create_canvas_project("PS").project_id
    image = Image.new("RGBA", (100, 60), (0, 0, 0, 0))
    image.paste((255, 0, 0, 255), (70, 10, 90, 30))
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", lossless=True)
    add_image(project_id, "image-webp", buffer.getvalue(), ext="webp")
    call(project_id, "/place", {"node_id": "image-webp"})
    assert ps.placed["format"] == "PNG" and ps.placed["size"] == (100, 60)
    assert ps.placed["png_content_bounds"] == [70, 10, 90, 30]
    assert (ps.placed["png_width"], ps.placed["png_height"]) == (100, 60)


def test_a_fully_transparent_image_is_not_sent(ps):
    project_id = create_canvas_project("PS").project_id
    add_image(project_id, "image-clear", _png(color=(0, 0, 0, 0)))
    error = refuse(project_id, "/place", {"node_id": "image-clear"})
    assert error.code == "PS_BAD_IMAGE" and ps.calls == []


def test_place_when_the_source_document_was_closed_names_it(ps):
    project_id = create_canvas_project("PS").project_id
    node_id = call(project_id, "/import")["node_id"]
    ps.failure = {"ok": False, "error": "Error: TARGET_NOT_OPEN", "target_name": "海报.psd"}
    error = refuse(project_id, "/place", {"node_id": node_id})
    assert (error.code, error.status) == ("PS_TARGET_NOT_OPEN", 409)
    assert error.message == "原文档「海报.psd」未打开，请先在 Photoshop 打开它"


def test_unsupported_platforms_say_so_instead_of_failing_later(ps, monkeypatch):
    monkeypatch.setattr(ps.bridge, "EXECUTOR", ps.bridge.UnsupportedExecutor())
    project_id = create_canvas_project("PS").project_id
    assert call(project_id, "/status")["supported"] is False
    assert refuse(project_id, "/import").status == 501


# ── 超时、取消与错误翻译 ──────────────────────────────────────────────


def test_a_timed_out_call_leaves_a_cancel_marker_for_the_late_script(ps, tmp_path):
    request = ps.bridge.Request(tmp_path / "req")
    request.directory.mkdir()
    error = ps.bridge.osascript_error(request.directory, "execution error: AppleEvent 已超时。 (-1712)")
    assert (error.code, error.status) == ("PS_BUSY", 503) and "已取消" in error.message
    assert request.path("cancelled").exists()
    ps.bridge.finish(request)
    assert request.directory.exists(), "带取消标记的目录要留着，迟到的脚本才看得到标记"


def test_a_cancelled_receipt_reads_as_busy(ps):
    project_id = create_canvas_project("PS").project_id
    ps.failure = {"ok": False, "error": "Error: CANCELLED"}
    assert refuse(project_id, "/import").code == "PS_BUSY"


@pytest.mark.parametrize(("stderr", "code", "status"), [
    ("execution error: Not authorized to send Apple events to Adobe Photoshop 2025. (-1743)",
     "PS_AUTOMATION_DENIED", 403),
    ("execution error: Adobe Photoshop 2025 got an error: Application isn't running. (-600)", "PS_NOT_RUNNING", 409),
    ("execution error: 发生了常规 Photoshop 错误。 (8800)", "PS_FAILED", 502),
])
def test_osascript_errors_become_one_sentence_for_the_user(ps, tmp_path, stderr, code, status):
    error = ps.bridge.osascript_error(tmp_path, stderr)
    assert (error.code, error.status) == (code, status)
    if code == "PS_AUTOMATION_DENIED":
        assert error.message == "需要在「系统设置 → 隐私与安全性 → 自动化」里允许 Atelier 控制 Photoshop"


def test_old_request_directories_are_swept(ps):
    root = ps.bridge.requests_root()
    stale = root / "stale"
    stale.mkdir(parents=True)
    (stale / "cancelled").write_text("1", encoding="utf-8")
    old = time.time() - ps.bridge.REQUEST_TTL_S - 10
    os.utime(stale, (old, old))
    project_id = create_canvas_project("PS").project_id
    call(project_id, "/import")
    assert not stale.exists()


def test_origin_records_are_capped_by_age(ps):
    origins = sys.modules[f"{plugin_server._module_name(PLUGIN_ID)}.origins"]
    data = None
    for index in range(origins.MAX_ORIGINS + 3):
        data = origins.record(data, f"v{index}", {"at": f"2026-11-19T00:00:{index:05d}"})
    assert len(data["origins"]) == origins.MAX_ORIGINS
    assert "v0" not in data["origins"] and f"v{origins.MAX_ORIGINS + 2}" in data["origins"]
