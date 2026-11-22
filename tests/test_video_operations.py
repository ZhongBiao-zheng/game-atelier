import asyncio
import threading

import pytest

from character_workflow.lib import video_operations as ops
from character_workflow.lib.canvas_projects import (
    canvas_project_dir, create_canvas_project, read_canvas_document, save_canvas_upload,
)


def upload():
    project = create_canvas_project("视频").project_id
    document = read_canvas_document(project)
    version, _, _ = save_canvas_upload(project, "demo.mp4", ".mp4",
                                        b"\0\0\0\x18ftypisom" + bytes(256), "video", document.revision)
    return project, version


def request(version, key):
    return ops.Submit(version_id=version.version_id, request_id=key,
                      operation={"kind": "video_trim", "start_ms": 0, "end_ms": 500})


async def render(project, body, path, progress):
    path.write_bytes(b"rendered")
    return {"width": 320, "height": 192, "duration_ms": 500}


async def test_serial_retry_cancel_and_commit():
    project, version = upload()
    started, resume = asyncio.Event(), asyncio.Event()
    order = []

    async def slow(project, body, path, progress):
        order.append(body.request_id)
        progress(250)
        started.set()
        await resume.wait()
        return await render(project, body, path, progress)

    queue = ops.VideoQueue(slow)
    first, second, third = await asyncio.gather(*(queue.submit(project, request(version, key))
                                                  for key in ("one", "two", "three")))
    await started.wait()
    ref = ops.Record(project, first["operation_id"])
    assert (await queue.get(ref))["processed_ms"] == 250
    assert (await queue.submit(project, request(version, "one")))["operation_id"] == ref.id
    conflict = request(version, "one")
    conflict.operation.end_ms = 100
    with pytest.raises(ops.VideoError, match="其他参数"):
        await queue.submit(project, conflict)
    assert (await queue.cancel(ops.Record(project, second["operation_id"])))["status"] == "canceled"
    assert (await queue.cancel(ref))["status"] == "canceled"
    assert not ref.stage.exists()
    resume.set()
    await queue.worker
    third_ref = ops.Record(project, third["operation_id"])
    assert (await queue.cancel(third_ref))["status"] == "succeeded"
    assert order == ["one", "three"]
    doc = read_canvas_document(project)
    assert len(doc.nodes) == 1 and len(doc.content_versions) == 2
    derived = doc.content_versions[doc.nodes[0].data.current_version_id]
    assert derived.origin.source_version_id == version.version_id
    assert (canvas_project_dir(project) / version.path).is_file()


async def test_disk_failure_and_restart(monkeypatch):
    project, version = upload()
    queue = ops.VideoQueue(render)

    def disk_full(*args):
        raise OSError("disk full")

    monkeypatch.setattr(ops, "_write_project_state_unlocked", disk_full)
    row = await queue.submit(project, request(version, "one"))
    ref = ops.Record(project, row["operation_id"])
    await queue.worker
    assert ref.read()["status"] == "failed"
    assert not ref.output.exists() and not ref.stage.exists()
    ref.write(row, "committing")
    ref.stage.mkdir()
    ref.output.mkdir()
    other = ref.root / "unowned"
    other.mkdir()
    await ops.VideoQueue(render).initialize()
    assert ref.read()["error_code"] == "interrupted"
    assert not ref.stage.exists() and not ref.output.exists() and other.exists()


async def test_cancel_at_publication_boundary(monkeypatch):
    project, version = upload()
    entered, proceed = threading.Event(), threading.Event()
    publish = ops._write_project_state_unlocked

    def delayed(*args):
        entered.set()
        assert proceed.wait(5)
        publish(*args)

    monkeypatch.setattr(ops, "_write_project_state_unlocked", delayed)
    queue = ops.VideoQueue(render)
    row = await queue.submit(project, request(version, "commit"))
    ref = ops.Record(project, row["operation_id"])
    assert await asyncio.to_thread(entered.wait, 5)
    cancel = asyncio.create_task(queue.cancel(ref))
    await asyncio.sleep(0.02)
    assert not cancel.done()
    proceed.set()
    assert (await cancel)["status"] == "succeeded"
    await queue.worker
    ref.write(row, "committing")
    await ops.VideoQueue(render).initialize()
    assert ref.read()["status"] == "succeeded"
    assert len(read_canvas_document(project).nodes) == 1


async def test_compression_without_reduction_preserves_original():
    project, version = upload()

    async def larger(project, body, path, progress):
        info = await render(project, body, path, progress)
        path.write_bytes(bytes(version.bytes + 1))
        return info

    queue = ops.VideoQueue(larger)
    body = ops.Submit(request_id="compress", version_id=version.version_id,
                      operation={"kind": "video_compress", "max_long_edge": 320, "quality": "small"})
    row = await queue.submit(project, body)
    await queue.worker
    ref = ops.Record(project, row["operation_id"])
    assert ref.read()["status"] == "succeeded" and "已保留原件" in ref.read()["message"]
    assert not read_canvas_document(project).nodes and not ref.output.exists()

