"""画布 Agent 的待办（update_plan）：存会话旁的 sidecar、接口读取、推送面板、随会话删除、不进导出包。"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from character_workflow.lib import canvas_agent_plans as plans
from character_workflow.lib import canvas_agent_runtime as runtime
from character_workflow.lib.canvas_agent_sessions import read_canvas_agent_session

from tests.test_canvas_agent_batch import _project, client  # noqa: F401

STEPS = [{"title": "读角色规范", "status": "completed"},
         {"title": "批量出 4 张立绘", "status": "in_progress"},
         {"title": "核对尺寸与透明", "status": "pending"}]


def _session(client) -> tuple[str, str, str]:  # noqa: F811
    project_id = _project(client)
    session_id = client.post(f"/api/canvas/projects/{project_id}/agent/sessions",
                             json={}).json()["session_id"]
    return project_id, session_id, f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}"


def _invoke(project_id: str, session_id: str, arguments: dict, events: list | None = None) -> str:
    tool = {t.name: t for t in runtime.build_tools()}["update_plan"]
    turn = runtime.TurnContext(project_id, "review", session_id=session_id,
                               notify=(lambda channel, payload: events.append((channel, payload)))
                               if events is not None else None)
    return asyncio.run(tool.on_invoke_tool(SimpleNamespace(context=turn), json.dumps(arguments)))


def test_plan_is_written_beside_the_session_and_pushed_to_the_panel(client):  # noqa: F811
    project_id, session_id, base = _session(client)
    assert client.get(f"{base}/plan").json() is None  # 还没写过
    tool = {t.name: t for t in runtime.build_tools()}["update_plan"]
    assert tool.needs_approval is False and "update_plan" in runtime.READ_TOOLS  # 不改画布，不弹确认

    events: list = []
    result = json.loads(_invoke(project_id, session_id, {"items": STEPS}, events))
    assert result == {"ok": True, "items": 3, "completed": 1}
    assert events == [("canvas-agent", {"project_id": project_id, "session_id": session_id,
                                        "kind": "plan"})]
    assert plans.plan_path(project_id, session_id).parent.name == "plans"
    body = client.get(f"{base}/plan").json()
    assert body["items"] == STEPS and body["schema_version"] == 1 and body["updated_at"]
    # 整份替换；会话文件本身不变（不加 CanvasAgentSession 字段）。
    before = read_canvas_agent_session(project_id, session_id).model_dump()
    _invoke(project_id, session_id, {"items": [{"title": "全部完成", "status": "completed"}]})
    assert [item["title"] for item in client.get(f"{base}/plan").json()["items"]] == ["全部完成"]
    assert read_canvas_agent_session(project_id, session_id).model_dump() == before


def test_bad_plans_go_back_to_the_model_and_keep_the_old_one(client):  # noqa: F811
    project_id, session_id, base = _session(client)
    _invoke(project_id, session_id, {"items": STEPS})
    for bad in ({"items": [{"title": f"第 {i} 步", "status": "pending"} for i in range(13)]},
                {"items": [{"title": "x", "status": "done"}]},
                {"items": [{"title": "", "status": "pending"}]},
                {"items": [{"title": "x" * 81, "status": "pending"}]},
                {}):
        events: list = []
        assert _invoke(project_id, session_id, bad, events).startswith("参数错误")
        assert events == []
    assert client.get(f"{base}/plan").json()["items"] == STEPS


def test_unreadable_plan_reads_as_none_and_missing_session_is_404(client):  # noqa: F811
    project_id, session_id, base = _session(client)
    path = plans.plan_path(project_id, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"items": "坏了"}', encoding="utf-8")
    response = client.get(f"{base}/plan")
    assert response.status_code == 200 and response.json() is None
    missing = client.get(f"/api/canvas/projects/{project_id}/agent/sessions/session-0000000000000000/plan")
    assert missing.status_code == 404


def test_plan_goes_away_with_its_session_and_stays_out_of_project_packages(client):  # noqa: F811
    from character_workflow.lib.canvas_packages import _metadata_files
    from character_workflow.lib.canvas_projects import canvas_project_dir

    project_id, session_id, base = _session(client)
    _invoke(project_id, session_id, {"items": STEPS})
    exported = {path.relative_to(canvas_project_dir(project_id)).as_posix()
                for path in _metadata_files(canvas_project_dir(project_id))}
    assert f"agent/sessions/{session_id}.json" in exported
    assert not any(path.startswith("agent/plans/") for path in exported)

    revision = client.get(base).json()["revision"]
    deleted = client.delete(base, headers={"If-Match": f'"{revision}"'})
    assert deleted.status_code == 204, deleted.text
    assert not plans.plan_path(project_id, session_id).exists()
