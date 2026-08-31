from fastapi.testclient import TestClient

from character_workflow.lib import canvas_runs
from viewer_server.server_app import build_app


def test_retry_api_preserves_failure_code_and_recovery(
    isolated_data_root,
    monkeypatch,
):
    def fail_retry(*_args, **_kwargs):
        raise RuntimeError("run_not_terminal")

    monkeypatch.setattr(canvas_runs, "retry_canvas_run", fail_retry)
    client = TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))

    response = client.post(
        "/api/canvas/projects/canvas-one/runs/run-one/retry",
        json={"expected_revision": 3},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "run_not_terminal",
        "message": "当前生成尚未结束，不能重试",
        "recovery": "等待当前生成结束，或先停止生成。",
    }
