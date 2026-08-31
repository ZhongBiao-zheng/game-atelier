"""async 路由里的同步阻塞调用必须走线程池。

这些路由不得不写成 async——它们要 await 读上传流。但接下来那一段是同步的：解码媒体、
抢画布文件锁、写 job、扫整个项目包。直接写在协程里，事件循环就停在那儿，SSE 一起断；
画布那几处还会去抢文件锁，Skill 进程持锁时是没有上限的等待。

判据用的是「被调用时当前线程有没有在跑事件循环」：线程池 worker 里 get_running_loop() 抛
RuntimeError，协程里则返回 loop。把任何一处的 run_in_threadpool 去掉，对应用例立刻变红。
"""
from __future__ import annotations

import asyncio
import base64

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


# 1×1 PNG —— 上传会按魔术字节核对内容与扩展名是否一致。
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _patch(monkeypatch, module_path: str, name: str, *, short_circuit=None) -> list[bool]:
    """把某个阻塞实现换成记录器：记下调用发生在协程里还是线程池 worker 里。

    short_circuit 给一个异常工厂时不跑真实实现——用在准备真实前置数据太贵的路由上，
    路由把这个异常翻成一个确定的状态码，用例照样能读到记录。
    """
    import importlib
    module = importlib.import_module(module_path)
    original = getattr(module, name)
    on_loop: list[bool] = []

    def wrapped(*args, **kwargs):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            on_loop.append(False)
        else:
            on_loop.append(True)
        if short_circuit is not None:
            raise short_circuit()
        return original(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapped)
    return on_loop


def _create_project(client: TestClient, name: str = "线程池") -> str:
    response = client.post("/api/canvas/projects", json={"name": name})
    assert response.status_code == 201, response.json()
    return response.json()["project_id"]


def test_runtime_upload_writes_off_the_event_loop(client, monkeypatch):
    on_loop = _patch(monkeypatch, "viewer_server.routes", "atomic_write_bytes")
    response = client.post("/api/uploads", files={"file": ("a.png", _PNG, "image/png")})
    assert response.status_code == 200, response.text
    assert on_loop == [False]


def test_gallery_upload_writes_its_job_off_the_event_loop(client, monkeypatch):
    on_loop = _patch(monkeypatch, "viewer_server.routes", "write_job")
    response = client.post(
        "/api/characters/hero/gallery/portrait",
        files={"file": ("a.png", _PNG, "image/png")},
    )
    assert response.status_code == 200, response.text
    assert on_loop == [False]


def test_canvas_upload_takes_the_project_lock_off_the_event_loop(client, monkeypatch):
    project_id = _create_project(client)
    on_loop = _patch(
        monkeypatch, "character_workflow.lib.canvas_projects", "save_canvas_upload"
    )
    response = client.post(
        f"/api/canvas/projects/{project_id}/uploads",
        files={"file": ("a.png", _PNG, "image/png")},
        data={"expected_revision": "0"},
    )
    assert response.status_code == 201, response.text
    assert on_loop == [False]


def test_canvas_media_replace_runs_off_the_event_loop(client, monkeypatch):
    project_id = _create_project(client)
    document = client.get(f"/api/canvas/projects/{project_id}/document").json()
    document["nodes"] = [{
        "id": "image-empty",
        "title": "空图片",
        "type": "image",
        "position": {"x": 0, "y": 0},
        "data": {
            "current_version_id": None,
            "generation_draft": None,
            "active_run_id": None,
            "display": {"fit": "contain", "free_resize": False},
        },
    }]
    saved = client.put(
        f"/api/canvas/projects/{project_id}/document",
        json=document,
        headers={"If-Match": str(document["revision"])},
    )
    assert saved.status_code == 200, saved.text

    on_loop = _patch(
        monkeypatch,
        "character_workflow.lib.canvas_projects",
        "replace_canvas_node_media",
    )
    response = client.post(
        f"/api/canvas/projects/{project_id}/nodes/image-empty/replace",
        files={"file": ("a.png", _PNG, "image/png")},
        data={"expected_revision": str(saved.json()["revision"])},
    )
    assert response.status_code == 201, response.text
    assert on_loop == [False]


def test_canvas_package_inspection_runs_off_the_event_loop(client, monkeypatch):
    # 落盘那一步同样在线程池里（run_in_threadpool(output.write, chunk)），这里只钉住整包扫描：
    # 它才是会跑满几秒、还要抢画布锁的一步。
    from character_workflow.lib.canvas_packages import CanvasPackageError
    on_loop = _patch(
        monkeypatch, "character_workflow.lib.canvas_packages", "inspect_canvas_package",
        short_circuit=lambda: CanvasPackageError("short-circuited by the test"),
    )
    response = client.post(
        "/api/canvas/projects/import/inspect",
        files={"file": ("pack.zip", b"PK\x05\x06" + b"\x00" * 18, "application/zip")},
    )
    assert response.status_code == 422, response.text
    assert on_loop == [False]


def test_canvas_mask_edit_submits_off_the_event_loop(client, monkeypatch):
    project_id = _create_project(client)
    on_loop = _patch(
        monkeypatch, "character_workflow.lib.canvas_runs", "submit_mask_edit_run",
        short_circuit=lambda: KeyError("short-circuited by the test"),
    )
    response = client.post(
        f"/api/canvas/projects/{project_id}/runs/mask-edit",
        files={"mask_file": ("mask.png", _PNG, "image/png")},
        data={"surface_node_id": "image-1", "expected_revision": "0", "requested_count": "1"},
    )
    assert response.status_code == 404, response.text
    assert on_loop == [False]
