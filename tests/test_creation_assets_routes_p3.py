"""项目参考库故障保持可识别的 HTTP 状态。"""
import pytest
from tests.local_client import LocalTestClient as TestClient
from viewer_server.server_app import build_app

@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _state_broken(*_args, **_kwargs):
    from character_workflow.lib.project_reference_assets import CreationAssetStateError

    raise CreationAssetStateError("创作资产库状态损坏")


def test_creation_asset_state_error_is_500_asset_state_broken(client, monkeypatch):
    """本机资产库坏了刷新也修不好：一律 500 asset_state_broken，不是 409（前端 409 = 刷新重试）。"""
    from character_workflow.lib import project_reference_assets as creation_assets

    # 画布插入：媒体 blob 缺失 / catalog 损坏原先落进 ValueError → 422。
    monkeypatch.setattr(creation_assets, "insert_creation_asset_into_canvas", _state_broken)
    insert = client.post(
        "/api/canvas/projects/cp-x/creation-assets/ca_x/insert",
        headers={"If-Match": "0"}, json={"position": {"x": 0, "y": 0}},
    )
    assert insert.status_code == 500, insert.text
    assert insert.json()["detail"] == {
            "code": "asset_state_broken", "message": "创作资产库状态损坏",
        }
