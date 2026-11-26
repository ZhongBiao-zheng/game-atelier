from pathlib import Path

from fastapi.testclient import TestClient

from character_workflow.lib import collab_config
from character_workflow.lib.canvas_projects import create_canvas_project, read_canvas_document, resolve_canvas_media
from character_workflow.lib.canvas_reproduce import reproduce_frozen_version
from character_workflow.lib.collab_provenance import studio_output_snapshot
from character_workflow.lib.schemas import CanvasPoint
from tests.test_generation_recipe import _studio_job, _upload, png
from viewer_server.collab_app import create_collab_app


def test_ingest_snapshot_and_reproduce_with_local_inputs(isolated_data_root):
    original_ref = _upload(isolated_data_root, "input.png", png((20, 80, 10)))
    job = _studio_job(png((10, 20, 30)), {"reference_images": [str(original_ref)], "quality": "high"})
    output, snapshot, refs = studio_output_snapshot(job, 0)
    pid = create_canvas_project("房主画布").project_id
    collab_config.enable_share(pid, collab_config.ShareSettings())
    root = f"/collab/v1/projects/{pid}"
    with TestClient(create_collab_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        token = client.post(root + "/auth", json={"display_name": "林"}).json()["collab_token"]
        headers = {"authorization": "Bearer " + token}
        files = {name: ("media", path.read_bytes()) for name, path in {"output": output, **refs}.items()}
        data = {"snapshot": snapshot.model_dump_json()}
        broken = client.post(root + "/ingest-node", headers=headers, data=data, files={"output": files["output"]})
        assert broken.status_code == 422
        assert read_canvas_document(pid).revision == 0
        result = client.post(root + "/ingest-node", headers=headers, data=data, files=files)
        assert result.status_code == 200, result.text
        collab_config.enable_share(pid, collab_config.ShareSettings(mode="view"))
        assert client.post(root + "/ingest-node", headers=headers, data=data, files=files).status_code == 403
    doc = read_canvas_document(pid)
    node, = doc.nodes
    assert node.created_by == "林" and doc.revision == 1
    version = doc.content_versions[node.data.current_version_id]
    ref_id = version.frozen_generation.inputs[0].version_id
    assert ref_id not in refs
    Path(job.output_paths[0]).unlink()
    original_ref.unlink()
    assert resolve_canvas_media(pid, ref_id)[0].read_bytes() == png((20, 80, 10))
    copied = reproduce_frozen_version(pid, version.version_id, CanvasPoint(x=50, y=0), None, None, 1)
    assert len(copied.nodes) == 3
    assert copied.nodes[-1].data.generation_draft.model == ""
    assert copied.nodes[-1].data.generation_draft.params.quality == "high"
    assert copied.connections[0].source_node_id == copied.nodes[-2].id
