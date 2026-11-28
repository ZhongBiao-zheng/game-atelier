from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from zipfile import ZipFile

import pytest

from character_workflow.lib import library, trash
from tests.local_client import LocalTestClient
from tests.test_asset_history import seed
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path):
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))


def test_folder_tree_copy_move_delete_and_restore(client):
    def folder(name, parent=None):
        return client.post("/api/library/folders", json={"name": name, "parent_id": parent})
    root = folder("包装").json()["id"]
    child = folder("终稿", root).json()["id"]
    assert folder("第三层", child).status_code == 422
    assert client.patch("/api/library/" + root, json={"parent_id": child}).status_code == 422
    item = client.post(f"/api/library/{child}/upload", files={"file": ("稿.md", b"hello")}).json()["id"]
    clone = client.post(f"/api/library/{root}/copy", json={}).json()["id"]
    state = client.get("/api/library").json()
    cloned_child, = [f for f in state["folders"] if f.get("parent_id") == clone]
    cloned_item, = cloned_child["item_ids"]
    assert cloned_item != item
    assert client.patch(f"/api/library/{cloned_item}", json={"title": "另一稿"}).is_success
    assert library.media(item)[0]["title"] == "稿.md"
    fav = client.post(f"/api/library/{item}/favorite", json={}).json()["id"]
    assert fav not in {item, cloned_item}
    assert client.post(f"/api/library/{cloned_item}/move", json={"target": root}).is_success
    archive = client.post("/api/library/download", json=[root])
    with ZipFile(BytesIO(archive.content)) as zip_file:
        assert zip_file.read("包装/终稿/稿.md") == b"hello"
        assert zip_file.read("包装/另一稿.md") == b"hello"
    deleted = client.delete(f"/api/library/{root}").json()["trash_id"]
    assert client.get(f"/api/library/{item}/content").status_code == 404
    assert client.get(f"/api/library/{fav}/content").content == b"hello"
    assert client.post(f"/api/trash/{deleted}/restore").is_success
    assert client.get(f"/api/library/{item}/content").content == b"hello"
    for method, args in [("delete", {}), ("patch", {"json": {"name": "新名"}})]:
        assert getattr(client, method)("/api/library/favorites", **args).status_code == 422


def test_subject_unique_handle_copies_cover_and_item_undo():
    with ThreadPoolExecutor(4) as pool:
        rows = list(pool.map(lambda _: library.subject("阿橙"), range(4)))
    assert sorted(row["handle"] for row in rows) == ["a-cheng", "a-cheng-2", "a-cheng-3", "a-cheng-4"]
    subject = rows[0]["id"]
    first, second = [library.insert(subject, "参考", b"text", "text", ".txt", {})["id"] for _ in range(2)]
    library.update(subject, {"cover_item_id": second, "description": "橙色短发"})
    clone = library.duplicate(subject)
    assert set(clone["item_ids"]).isdisjoint([first, second])
    assert clone["cover_item_id"] == clone["item_ids"][1]
    deleted = library.remove(second)
    assert library._read(subject)["cover_item_id"] == first
    trash.restore(deleted)
    assert library._read(subject)["cover_item_id"] == second
    assert library._read(subject)["item_ids"] == [first, second]
    with pytest.raises(ValueError):
        library.update(subject, {"handle": rows[1]["handle"]})


def test_history_uses_visible_stable_output_and_independent_bytes(client):
    job = seed("job-test-library", count=2)
    ref = dict(job_id=job.job_id, output_index=1)
    url = "/api/library/favorites/history"
    item = client.post(url, json=ref).json()
    assert item["source"] == {"kind": "history", **ref}
    assert client.post("/api/gallery/hidden", json={"path": "studio/job-test-library/1.png", "hidden": True}).is_success
    assert client.post(url, json=ref).status_code == 404
    assert client.request("DELETE", f"/api/history/{job.job_id}", json=[1]).is_success
    assert client.get(f"/api/library/{item['id']}/content").content.startswith(b"\x89PNG")


def test_capacity_and_failed_copy_do_not_publish_orphans():
    owner = library.subject("模特")["id"]
    for n in range(20):
        library.insert(owner, str(n), b"ref", "text", ".md", {})
    before = library.catalog()
    with pytest.raises(ValueError, match="20"):
        library.duplicate(before["subjects"][0]["item_ids"][0], owner)
    assert library.catalog() == before
    assert len(list((library.root() / "items").iterdir())) == 20


def test_subject_editor_copies_a_local_item_once_and_checks_revision(client):
    import json

    folder = library.folder("源")
    item = library.insert(folder["id"], "文本", b"reference", "text", ".txt", {})
    form = {"name": "主体", "additions": [{"item_id": item["id"]}], "cover_index": 0}
    response = client.post("/api/library/subject-editor", files={"payload": (None, json.dumps(form))})
    assert response.is_success, response.text
    subject = response.json()
    copy = subject["cover_item_id"]
    assert copy != item["id"] and library.media(copy)[1].read_bytes() == b"reference"
    library.update(subject["id"], {"description": "新版本"})
    response = client.post("/api/library/subject-editor", files={"payload": (None, json.dumps({
        **form, "id": subject["id"], "revision": subject["revision"],
    }))})
    assert response.status_code == 422
    assert library._read(subject["id"])["item_ids"] == [copy]
