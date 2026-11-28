"""Explicit local API capabilities; an unregistered route is never a data escape hatch."""
from __future__ import annotations

from starlette.routing import compile_path

from character_workflow.lib.canvas_agent_schema import CANVAS_TOOL_INPUT_MODELS

# Local editor owns the existing personal workspace. Agent sessions never inherit these routes.
_LOCAL_ROUTES = """
GET /api/update/state
GET /api/update/result
POST /api/update/check
POST /api/update/apply
POST /api/update/cancel
GET /api/diagnostics/export
GET /api/jobs
GET /api/jobs/{job_id}
GET /api/config
POST /api/prompt/{job_id}
POST /api/clipboard-attempt
GET /api/raw
POST /api/uploads
DELETE /api/jobs/{job_id}
POST /api/jobs/{job_id}/confirm
POST /api/jobs/{job_id}/cancel
POST /api/config
GET /api/onboarding/status
POST /api/onboarding/data-root
POST /api/folder-picker
GET /api/data-root
POST /api/data-root
GET /api/ui-prefs
PUT /api/ui-prefs/{key}
POST /api/onboarding/events
GET /api/onboarding/metrics
POST /api/onboarding/key-probe
GET /api/keys
GET /api/provider-icons/{sha}
POST /api/provider-icons
POST /api/provider-icons/fetch
GET /api/subscriptions/chatgpt
POST /api/comfyui/connection
GET /api/comfyui/{alias}/workflows
POST /api/comfyui/{alias}/inspect
POST /api/comfyui/{alias}/workflows
DELETE /api/comfyui/{alias}/workflows/{identifier}
GET /api/http-protocols
POST /api/http-protocols
POST /api/http-protocols/validate
GET /api/http-protocols/assist/models
POST /api/http-protocols/assist
GET /api/http-protocols/{identifier}
PUT /api/http-protocols/{identifier}
DELETE /api/http-protocols/{identifier}
GET /api/trash
POST /api/trash/{trash_id}/restore
DELETE /api/trash/{trash_id}
DELETE /api/trash
GET /api/plugins
POST /api/plugins/{plugin_id}/enable
POST /api/plugins/{plugin_id}/disable
GET /api/plugins/{plugin_id}/package/{file:path}
POST /api/plugins/{plugin_id}/routes/{route:path}
GET /api/canvas/projects/{project_id}/plugin-grants
PUT /api/canvas/projects/{project_id}/plugin-grants/{plugin_id}
DELETE /api/canvas/projects/{project_id}/plugin-grants/{plugin_id}
POST /api/keys
PATCH /api/keys/{alias}
DELETE /api/keys/{alias}
GET /api/keys/{alias}/reveal
POST /api/keys/models-preview
GET /api/models
PUT /api/models/order
PUT /api/models/mode
GET /api/gateway/audit
GET /api/gateway/providers/{alias}/admin/keys
POST /api/gateway/providers/{alias}/admin/keys
PATCH /api/gateway/providers/{alias}/admin/keys/{key_id}
POST /api/gateway/providers/{alias}/admin/keys/{key_id}/reset
POST /api/gateway/providers/{alias}/admin/keys/{key_id}/revoke
GET /api/gateway/providers/{alias}/admin/options
GET /api/gateway/providers/{alias}/admin/usage
GET /api/gateway/providers/{alias}/admin/usage/tasks
GET /api/gateway/providers/{alias}/admin/tasks
GET /api/gateway/providers/{alias}/admin/live
GET /api/gateway/providers/{alias}/admin/members
POST /api/gateway/providers/{alias}/admin/members/{member_alias}/restore
GET /api/gateway/providers/{alias}/admin/routes
PUT /api/gateway/providers/{alias}/admin/routes/order
GET /api/gateway/providers/{alias}/admin/audit
GET /api/gateway
GET /api/gateway/service
POST /api/gateway/service/install
PUT /api/gateway
POST /api/gateway/keys
GET /api/gateway/keys/{key_id}/token
PATCH /api/gateway/keys/{key_id}
POST /api/gateway/keys/{key_id}/reset
POST /api/gateway/keys/{key_id}/revoke
GET /api/gateway/tasks
GET /api/gateway/tasks/{task_id}/outputs/{index}
GET /api/gateway/providers/{alias}/me
GET /api/gateway/options
GET /api/model-routes/member-status
POST /api/model-routes/member-status/restore
GET /api/usage
GET /api/usage/tasks
GET /api/usage/key-last-used
GET /api/pricing/tokendance
GET /api/announcements
POST /api/pricing/estimate
POST /api/pricing/estimate-batch
GET /api/models/durations
POST /api/gateway/check
POST /api/gateway/providers/{alias}/sync
GET /api/collab/status
GET /api/collab/shares
PUT /api/collab/shares/{project_id}
DELETE /api/collab/shares/{project_id}
POST /api/collab/shares/stop-all
GET /api/collab/peers
POST /api/collab/peers/manual
DELETE /api/collab/peers/manual
POST /api/collab/remote/{peer_key}/projects/{project_id}/image-edits
POST /api/collab/remote/{peer_key}/projects/{project_id}/uploads
POST /api/collab/remote/{peer_key}/projects/{project_id}/auth
GET /api/collab/remote/{peer_key}/projects/{project_id}/document
GET /api/collab/remote/{peer_key}/projects/{project_id}/cover
GET /api/collab/remote/{peer_key}/projects/{project_id}/versions/{version_id}/media
POST /api/collab/remote/{peer_key}/projects/{project_id}/copy-to-local
POST /api/collab/remote/{peer_key}/projects/{project_id}/send-to-studio
GET /api/collab/remote/{peer_key}/projects/{project_id}/borrowable-models
POST /api/collab/remote/{peer_key}/projects/{project_id}/runs/local
POST /api/collab/remote/{peer_key}/projects/{project_id}/runs/borrowed
POST /api/studio/jobs/{job_id}/shared-canvas
GET /api/library
GET /api/library/handle
GET /api/library/{key}/content
POST /api/library/download
POST /api/library/folders
POST /api/library/subjects
POST /api/library/subject-preview
POST /api/library/subject-editor
POST /api/library/{owner}/upload
POST /api/library/{owner}/canvas
POST /api/library/{owner}/history
POST /api/library/{key}/{action}
PATCH /api/library/{key}
DELETE /api/library/{key}
GET /api/history
GET /api/history/{job_id}/{output_index}/thumb
POST /api/history/download
DELETE /api/history/{job_id}
GET /api/gallery/recent
GET /api/gallery/hidden
POST /api/gallery/hidden
GET /api/gallery/favorites
POST /api/gallery/favorites
GET /api/gallery/ratings
POST /api/gallery/ratings
GET /api/gallery/image
GET /api/canvas/projects
GET /api/canvas/project-options
GET /api/canvas/ui-preferences
PUT /api/canvas/ui-preferences
GET /api/accent-themes
PUT /api/accent-themes
POST /api/canvas/projects
PATCH /api/canvas/projects/{project_id}
POST /api/canvas/projects/export
POST /api/canvas/projects/import/inspect
POST /api/canvas/projects/import/commit
DELETE /api/canvas/projects/{project_id}
GET /api/canvas/projects/{project_id}/document
POST /api/canvas/projects/{project_id}/versions/{version_id}/reproduce
PUT /api/canvas/projects/{project_id}/document
GET /api/canvas/projects/{project_id}/agent/sessions
POST /api/canvas/projects/{project_id}/agent/sessions
GET /api/canvas/projects/{project_id}/agent/sessions/{session_id}
DELETE /api/canvas/projects/{project_id}/agent/sessions/{session_id}
PATCH /api/canvas/projects/{project_id}/agent/sessions/{session_id}
POST /api/canvas/projects/{project_id}/agent/sessions/{session_id}/messages
POST /api/canvas/projects/{project_id}/agent/sessions/{session_id}/approvals
GET /api/canvas/projects/{project_id}/agent/sessions/{session_id}/approvals/{call_id}/items
POST /api/canvas/projects/{project_id}/agent/sessions/{session_id}/cancel
GET /api/canvas/projects/{project_id}/agent/sessions/{session_id}/usage
GET /api/canvas/projects/{project_id}/agent/sessions/{session_id}/plan
GET /api/canvas/agent/models
GET /api/canvas/agent/generation-models
GET /api/canvas/agent/settings
PUT /api/canvas/agent/settings
GET /api/canvas/agent/skills
POST /api/canvas/agent/skills/import
DELETE /api/canvas/agent/skills/{name}
GET /api/creation-assets
PATCH /api/creation-assets/{asset_id}
PUT /api/canvas/projects/{project_id}/categories
POST /api/canvas/projects/{project_id}/classify
GET /api/canvas/projects/{project_id}/specs
PUT /api/canvas/projects/{project_id}/specs/project
PUT /api/canvas/projects/{project_id}/specs/categories/{name:path}
GET /api/canvas/projects/{project_id}/lessons
POST /api/canvas/projects/{project_id}/lessons/{index}/adopt
DELETE /api/canvas/projects/{project_id}/lessons/{index}
POST /api/creation-assets/staleness
POST /api/creation-assets/media/from-path
POST /api/creation-assets/media/upload
POST /api/creation-assets/{asset_id}/use
GET /api/creation-assets/{asset_id}/content
GET /api/creation-assets/{asset_id}/inputs/{order}
GET /api/creation-assets/{asset_id}/staleness
POST /api/creation-assets/{asset_id}/readopt
POST /api/canvas/projects/{project_id}/creation-assets/{asset_id}/insert
POST /api/canvas/projects/{project_id}/creation-assets/{asset_id}/reproduce
GET /api/team-library-gateway-share
PUT /api/team-library-gateway-share/{library_id}
GET /api/gateway-libraries
GET /api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/content
GET /api/gateway-shares
DELETE /api/gateway-shares/{library_id}
GET /api/gateway-libraries/{alias}/{library_id}/assets
GET /api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/thumb
GET /api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/previews/{n}/thumb
GET /api/profile
PUT /api/profile
GET /api/team-libraries
POST /api/team-libraries
DELETE /api/team-libraries/{library_id}
POST /api/team-libraries/{library_id}/rescan
GET /api/team-libraries/{library_id}/assets
GET /api/team-libraries/{library_id}/assets/{entry_id}/content
GET /api/team-libraries/{library_id}/assets/{entry_id}/thumb
GET /api/team-libraries/{library_id}/assets/{entry_id}/previews/{file}/thumb
POST /api/team-libraries/{library_id}/assets/{entry_id}/adopt
GET /api/team-libraries/related
POST /api/team-libraries/{library_id}/share
PUT /api/team-libraries/{library_id}/assets/{asset_id}
DELETE /api/team-libraries/{library_id}/assets/{asset_id}
GET /api/team-libraries/{library_id}/specs
PUT /api/team-libraries/{library_id}/specs/team
PUT /api/team-libraries/{library_id}/specs/categories/{name:path}
POST /api/canvas/projects/{project_id}/paste
POST /api/canvas/projects/{project_id}/uploads
POST /api/canvas/projects/{project_id}/nodes/{node_id}/replace
POST /api/canvas/projects/{project_id}/media-operations
GET /api/canvas/matting-model
POST /api/canvas/matting-model
GET /api/canvas/projects/{project_id}/versions/{version_id}/media
GET /api/canvas/projects/{project_id}/versions/{version_id}/download
GET /api/canvas/projects/{project_id}/nodes/{node_id}/layers/download
GET /api/canvas/projects/{project_id}/jobs
GET /api/canvas/projects/{project_id}/group-runs
POST /api/canvas/projects/{project_id}/groups/{group_id}/group-runs
POST /api/canvas/projects/{project_id}/group-runs/{run_id}/resume
POST /api/canvas/projects/{project_id}/group-runs/{run_id}/cancel
POST /api/canvas/projects/{project_id}/groups/{group_id}/run-plan
POST /api/canvas/projects/{project_id}/runs/reverse-prompt
POST /api/canvas/projects/{project_id}/runs/text-revision
POST /api/canvas/projects/{project_id}/runs/angle
POST /api/canvas/projects/{project_id}/runs/upscale
POST /api/canvas/projects/{project_id}/upscale/estimate
POST /api/canvas/projects/{project_id}/image-edits
POST /api/canvas/projects/{project_id}/runs/image-edit
POST /api/canvas/projects/{project_id}/runs/layer-decomposition
POST /api/canvas/projects/{project_id}/runs/{run_id}/reverse-prompt-config
POST /api/canvas/projects/{project_id}/runs
POST /api/canvas/projects/{project_id}/runs/{run_id}/cancel
POST /api/canvas/projects/{project_id}/runs/{run_id}/resume-mj-edit
POST /api/canvas/projects/{project_id}/runs/{run_id}/candidates/{candidate_id}/dismiss
POST /api/studio/jobs
GET /api/studio/jobs/by-request/{request_id}
POST /api/studio/jobs/{job_id}/requery
DELETE /api/studio/jobs/{job_id}
POST /api/studio/jobs/{job_id}/canvas
GET /api/studio/agent/sessions
POST /api/studio/agent/sessions
GET /api/studio/agent/sessions/{session_id}
PATCH /api/studio/agent/sessions/{session_id}
DELETE /api/studio/agent/sessions/{session_id}
POST /api/studio/agent/sessions/{session_id}/messages
POST /api/studio/agent/sessions/{session_id}/approvals
GET /api/studio/agent/sessions/{session_id}/approvals/{call_id}/items
POST /api/studio/agent/sessions/{session_id}/cancel
GET /api/studio/agent/sessions/{session_id}/usage
GET /api/studio/agent/sessions/{session_id}/plan
GET /api/studio/agent/sessions/{session_id}/jobs
POST /api/studio/agent/sessions/{session_id}/attachments
GET /api/studio/agent/sessions/{session_id}/attachments/{attachment_id}
GET /events
GET /docs
GET /docs/oauth2-redirect
GET /redoc
GET /openapi.json
""".strip().splitlines()

LOCAL_MANAGEMENT = frozenset({
    "/api/diagnostics/export",
    "/api/gateway-shares", "/api/gateway-shares/{library_id}",
    "/api/gateway/keys/{key_id}/reset", "/api/gateway/providers/{alias}/admin/keys/{key_id}/reset",
    "/api/team-library-gateway-share", "/api/team-library-gateway-share/{library_id}",
    "/api/models/durations", "/api/pricing/estimate-batch",
    "/api/update/state", "/api/update/result", "/api/update/check",
    "/api/update/apply", "/api/update/cancel",
    "/api/gateway/audit",
    "/api/gateway/providers/{alias}/admin/audit",
    "/api/gateway/providers/{alias}/admin/keys",
    "/api/gateway/providers/{alias}/admin/keys/{key_id}",
    "/api/gateway/providers/{alias}/admin/keys/{key_id}/revoke",
    "/api/gateway/providers/{alias}/admin/live",
    "/api/gateway/providers/{alias}/admin/members",
    "/api/gateway/providers/{alias}/admin/members/{member_alias}/restore",
    "/api/gateway/providers/{alias}/admin/options",
    "/api/gateway/providers/{alias}/admin/routes",
    "/api/gateway/providers/{alias}/admin/routes/order",
    "/api/gateway/providers/{alias}/admin/tasks",
    "/api/gateway/providers/{alias}/admin/usage",
    "/api/gateway/providers/{alias}/admin/usage/tasks",

    "/api/config", "/api/keys", "/api/keys/{alias}", "/api/keys/{alias}/reveal",
    # 上传供应商图标往数据目录写文件，属于供应商管理，只给本机页面。
    "/api/provider-icons", "/api/provider-icons/fetch",
    "/api/subscriptions/chatgpt",
    "/api/comfyui/connection", "/api/comfyui/{alias}/workflows",
    "/api/comfyui/{alias}/inspect", "/api/comfyui/{alias}/workflows/{identifier}",
    # 自定义接口模板决定密钥发往哪个路径、怎么发（ADR-0036），只给本机页面。
    "/api/http-protocols", "/api/http-protocols/validate", "/api/http-protocols/{identifier}",
    "/api/http-protocols/assist/models", "/api/http-protocols/assist",
    "/api/keys/models-preview", "/api/models/order", "/api/models/mode", "/api/folder-picker", "/api/onboarding/status", "/api/onboarding/data-root",
    "/api/data-root", "/api/onboarding/events", "/api/onboarding/metrics",
    # 引导里的 Key 探针会把密钥发给固定的厂商地址，只给本机页面。
    "/api/onboarding/key-probe",
    # 局域网共享：开关会让本机对局域网开端口，密钥与用量也只给本机页面（ADR-0025）。
    "/api/gateway", "/api/gateway/service", "/api/gateway/service/install", "/api/gateway/keys", "/api/gateway/keys/{key_id}",
    "/api/gateway/keys/{key_id}/token",
    "/api/gateway/keys/{key_id}/revoke", "/api/usage", "/api/usage/tasks", "/api/usage/key-last-used",
    "/api/gateway/check",
    "/api/gateway/providers/{alias}/sync", "/api/gateway/options",
    "/api/gateway/tasks", "/api/gateway/tasks/{task_id}/outputs/{index}",
    "/api/gateway/providers/{alias}/me",
    "/api/model-routes/member-status", "/api/model-routes/member-status/restore",
    # 挂载团队库 = 往本机任意目录写清单并整棵扫描，同 folder-picker 只给本机页面。
    "/api/team-libraries",
    # 启停插件决定本机加载哪些代码（ADR-0037），只给本机页面；列表与包文件仍可读。
    "/api/plugins/{plugin_id}/enable", "/api/plugins/{plugin_id}/disable",
    # 导入 / 删除 Agent Skill 改写数据目录里的说明文件，Agent 每轮都会读，只给本机页面。
    "/api/canvas/agent/skills/import", "/api/canvas/agent/skills/{name}",
    # Agent 出图的确认金额是花钱的闸门，只给本机页面。
    "/api/canvas/agent/settings",
    # 回收站能彻底删除用户数据，只给本机页面。
    "/api/trash", "/api/trash/{trash_id}", "/api/trash/{trash_id}/restore",
})
# 已脱敏的 Key 列表（alias / 能力 / 掩码）是选模型的依据，网站会话也要读；增删改与 reveal 仍属管理。
# 已挂载的团队库列表同理：网站会话要读它才能浏览 / 采用。
_MANAGEMENT_READ_EXEMPT = frozenset({("GET", "/api/keys"), ("GET", "/api/team-libraries")})
# 用 POST 只因为 id 列表放不进查询串；它只读，不需要编辑租约。
_READ_POSTS = frozenset({
    ("POST", "/api/creation-assets/staleness"),
})
MEDIA_ROUTES = frozenset({
    "/api/library/{key}/content",
    "/api/history/{job_id}/{output_index}/thumb",
    "/api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/content",
    "/api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/thumb",
    "/api/gateway-libraries/{alias}/{library_id}/assets/{entry_id}/previews/{n}/thumb",
    "/api/raw", "/api/images", "/api/gallery/image",
    "/api/creation-assets/{asset_id}/content",
    "/api/creation-assets/{asset_id}/inputs/{order}",
    "/api/canvas/projects/{project_id}/versions/{version_id}/media",
    "/api/canvas/projects/{project_id}/versions/{version_id}/download",
    "/api/canvas/projects/{project_id}/nodes/{node_id}/layers/download",
    "/api/team-libraries/{library_id}/assets/{entry_id}/content",
    "/api/team-libraries/{library_id}/assets/{entry_id}/thumb",
    "/api/team-libraries/{library_id}/assets/{entry_id}/previews/{file}/thumb",
    # 供应商自定义图标：文件名即内容 sha256，自带 immutable 缓存；模型菜单也显示，网站会话可读。
    "/api/provider-icons/{sha}",
})
CANVAS_TOOLS = frozenset(CANVAS_TOOL_INPUT_MODELS)
# 自定义接口的接入说明与干跑校验（ADR-0036，第 5 批 5-6B）：不挂项目，接口里再核对是 Agent。
PROTOCOL_TOOLS = frozenset({"protocol-manual", "protocol-validate"})


def is_canvas_tool_path(rest: str) -> bool:
    """`/api/canvas-agent/` 后面的部分是不是 Agent 工具：画布那几条、自定义接口两条、插件工具（ADR-0043）；后两类接口里再核对是 Agent。"""
    return rest in CANVAS_TOOLS or rest in PROTOCOL_TOOLS or rest == "plugin-tools" or (
        rest.startswith("plugin-tools/") and rest.count("/") == 2)
LOCAL_RULES = [
    (method, path, compile_path(path)[0])
    for entry in _LOCAL_ROUTES
    for method, path in [entry.split(" ", 1)]
]


def is_media_route(path: str) -> bool:
    """媒体路由自带缓存策略（缩略图 immutable），中间件不覆盖它们的 Cache-Control。"""
    return any(template in MEDIA_ROUTES and pattern.fullmatch(path) for _, template, pattern in LOCAL_RULES)


PLUGIN_ROUTE = "/api/plugins/{plugin_id}/routes/{route:path}"


def _plugin_route_capability(match) -> str | None:
    """插件路由不靠前缀放行：只有已启用插件在清单里声明过的那几条可达，读写类别也取清单的。"""
    from character_workflow.lib import plugin_server
    access = plugin_server.declared_access(match["plugin_id"], "POST", "/" + match["route"])
    return {"read": "read", "edit": "edit"}.get(access or "")


def local_capability(method: str, path: str) -> str | None:
    for allowed_method, template, pattern in LOCAL_RULES:
        if (allowed_method == method or (
            method == "HEAD" and allowed_method == "GET" and template in MEDIA_ROUTES
        )) and (match := pattern.fullmatch(path)):
            if template == PLUGIN_ROUTE:
                return _plugin_route_capability(match)
            if template in LOCAL_MANAGEMENT and (method, template) not in _MANAGEMENT_READ_EXEMPT:
                return "manage"
            if method in {"GET", "HEAD"} or (method, template) in _READ_POSTS:
                return "read"
            return "edit"
    return None
