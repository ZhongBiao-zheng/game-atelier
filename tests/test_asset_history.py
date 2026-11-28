from io import BytesIO
from zipfile import ZipFile

import pytest
from PIL import Image
from tests.local_client import LocalTestClient

from character_workflow.lib import data_root
from character_workflow.lib.jobs import save_job
from character_workflow.lib.schemas import Job, JobParams
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))


def seed(job_id, kind="image", namespace="studio", status="done", count=1):
    root = data_root.resolve_data_root()
    folder = root / ("canvases/demo/outputs" if namespace == "canvas" else "studio") / job_id
    paths = []
    for index in range(count):
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (f"{index}.png" if kind == "image" else f"{index}.txt")
        if kind == "image":
            Image.new("RGB", (15, 10)).save(path)
        else:
            path.write_text("第一行\n第二行", encoding="utf-8")
        paths.append(str(path))
    canvas_run = dict(run_id="run-a", result_node_id="result", candidates=[], snapshot=dict(
        surface_node_id="surface", result_node_id="result", mode=kind, final_prompt="test",
        input_policy="all_connected", model="test", provider="local", normalized_params={}, inputs=[],
        submitted_at="2026-11-27", submitted_by={"kind": "user"}, request_fingerprint="0" * 64,
    )) if namespace == "canvas" else None
    return save_job(Job(job_id=job_id, character_id=namespace, namespace=namespace, status=status,
                        canvas_run=canvas_run, canvas_project_id="demo" if namespace == "canvas" else None,
                        submitted_at="2026-11-27T12:00:00+08:00", kind=kind, prompt="长" * 120 + job_id,
                        model="test", error=None, params=JobParams(), output_paths=paths))


def test_cursor_inside_job_and_search_beyond_excerpt(client):
    seed("job-b", count=2)
    seed("job-a", "text", "canvas")
    seed("job-c", status="failed")
    seed("job-d", namespace="assist")
    first = client.get("/api/history", params={"limit": 1}).json()
    row = first["items"][0]
    assert (row["job_id"], row["output_index"], row["width"], row["height"]) == ("job-b", 0, 15, 10)
    assert client.get(row["thumbnail_url"]).status_code == 200
    rest = client.get("/api/history", params={"cursor": first["next_cursor"]}).json()
    assert [(r["job_id"], r["output_index"]) for r in rest["items"]] == [("job-b", 1), ("job-a", 0)]
    assert rest["next_cursor"] is None
    result = client.get("/api/history?kind=text&q=JOB-A").json()["items"]
    assert len(result) == 1 and len(result[0]["prompt"]) == 120
    assert result[0]["text_preview"] == "第一行\n第二行"
    assert client.get("/api/history?cursor=bad").status_code == 422


def test_hidden_paths_and_projects(client):
    seed("job-a")
    seed("job-b", namespace="canvas")
    for field in [{"path": "studio/job-a/0.png"}, {"canvas_project_id": "demo"}]:
        assert client.post("/api/gallery/hidden", json={**field, "hidden": True}).is_success
    assert client.get("/api/history").json()["items"] == []
    assert client.post("/api/history/download", json=[{"job_id": "job-a", "output_index": 0}]).status_code == 404


def test_download_files_and_duplicate_names(client):
    refs = []
    for key in ["job-a", "job-b"]:
        seed(key)
        refs.append(dict(job_id=key, output_index=0))
    single = client.post("/api/history/download", json=refs[:1])
    assert single.headers["content-type"] == "image/png"
    with ZipFile(BytesIO(client.post("/api/history/download", json=refs).content)) as archive:
        assert archive.namelist() == ["0.png", "2-0.png"]
        assert archive.read("2-0.png") == single.content


@pytest.mark.parametrize("namespace", ["studio", "canvas"])
def test_delete_restore_preserves_usage_and_canvas_files(client, namespace):
    from pathlib import Path
    job = seed("job-a", namespace=namespace)
    result = client.request("DELETE", "/api/history/job-a", json=[0]).json()
    assert client.get("/api/history").json()["items"] == []
    assert (data_root.runtime_dir() / "usage-archive/job-a.json").is_file()
    assert Path(job.output_paths[0]).is_file() == (namespace == "canvas")
    assert client.post("/api/trash/" + result["trash_id"] + "/restore").is_success
    assert client.get("/api/history").json()["items"][0]["job_id"] == "job-a"

def test_download_basenames_are_portable():
    from viewer_server.history_routes import _download_name
    assert _download_name(r"C:\work\CON.png") == "media-CON.png"
    assert _download_name("studio/job-a/scene:01?.png") == "scene-01-.png"


def test_real_video_dimensions_and_duration(client):
    from pathlib import Path
    from shutil import copyfile
    job = seed("job-video", kind="video")
    output = Path(job.output_paths[0]).with_suffix(".mp4")
    copyfile(Path(__file__).parent / "fixtures/video/h264-24f.mp4", output)
    save_job(job.model_copy(update={"output_paths": [str(output)]}))
    item = client.get("/api/history?kind=video").json()["items"][0]
    assert item["width"] > 0 and item["height"] > 0 and item["duration"] > 0


@pytest.mark.parametrize("namespace", ["studio", "canvas"])
def test_partial_outputs_can_be_removed_and_restored_in_stable_slots(client, namespace):
    from pathlib import Path
    from character_workflow.lib.jobs import output_slots, read_job, removed_output_slots

    job = seed("job-partial", namespace=namespace, status="partial", count=4)
    url = "/api/history/job-partial"
    def slots():
        return [row["output_index"] for row in client.get("/api/history").json()["items"]]

    assert slots() == [0, 1, 2, 3]
    assert client.request("DELETE", url, json=[1, 8]).status_code == 404
    assert client.request("DELETE", url, json=[]).status_code == 422
    selected = client.request("DELETE", url, json=[1, 3, 1]).json()["trash_id"]
    assert slots() == [0, 2]
    assert removed_output_slots(read_job(job.job_id)) == {1, 3}
    assert [Path(path).exists() for path in job.output_paths] == [True, namespace == "canvas"] * 2
    assert client.request("DELETE", url, json=[1]).status_code == 404
    whole = client.request("DELETE", url, json=[0, 2]).json()["trash_id"]
    assert slots() == []
    assert client.post(f"/api/trash/{selected}/restore").status_code == 409
    assert client.post(f"/api/trash/{whole}/restore").is_success
    assert slots() == [0, 2]
    assert client.post(f"/api/trash/{selected}/restore").is_success
    assert output_slots(read_job(job.job_id)) == list(enumerate(job.output_paths))
    assert all(Path(path).is_file() for path in job.output_paths)


def test_history_thumbnails_reuse_disk_cache_and_invalidate_on_source_change(client, monkeypatch):
    from pathlib import Path
    from character_workflow.lib import canvas_thumbnails
    path = Path(seed("job-image").output_paths[0])
    Image.new("RGB", (1024, 768), "blue").save(path)
    def thumb_url():
        return client.get("/api/history").json()["items"][0]["thumbnail_url"]

    url = thumb_url()
    first = client.get(url + "&width=380")
    assert Image.open(BytesIO(first.content)).size == (512, 384)
    assert "immutable" in first.headers["cache-control"]
    cache = data_root.runtime_dir() / "history-thumbnails"
    assert len(list(cache.rglob("*.webp"))) == 1
    with monkeypatch.context() as patch:
        def unexpected(*args):
            pytest.fail("cache hit decoded original again")
        patch.setattr(canvas_thumbnails, "_render_thumbnail", unexpected)
        assert client.get(url + "&width=512").content == first.content
    Image.new("RGB", (1200, 600), "red").save(path)
    assert thumb_url() != url
    assert "immutable" not in client.get(url).headers["cache-control"]
    updated = client.get(thumb_url() + "&width=512")
    assert Image.open(BytesIO(updated.content)).size == (512, 256)
    assert client.get(thumb_url() + "&width=1025").content == path.read_bytes()
