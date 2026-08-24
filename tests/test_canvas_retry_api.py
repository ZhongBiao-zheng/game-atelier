from fastapi.testclient import TestClient

from character_workflow.lib import canvas_runs
from viewer_server.server_app import build_app


def test_retry_api_preserves_snapshot_failure_code_and_recovery(
    isolated_data_root,
    monkeypatch,
):
    def fail_retry(*_args, **_kwargs):
        raise RuntimeError("snapshot_input_missing")

    monkeypatch.setattr(canvas_runs, "retry_canvas_run", fail_retry)
    client = TestClient(build_app(dist_dir=isolated_data_root / "dist"))

    response = client.post(
        "/api/canvas/projects/canvas-one/runs/run-one/retry",
        json={"mode": "original", "expected_revision": 3},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "snapshot_input_missing",
        "message": "原生成使用的输入版本已经不存在",
        "recovery": "检查历史输入；如需使用画布当前内容，请按当前设置再次生成。",
    }
