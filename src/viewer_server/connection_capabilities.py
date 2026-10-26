"""Explicit local API capabilities; an unregistered route is never a data escape hatch."""
from __future__ import annotations

from starlette.routing import compile_path

# Local editor owns the existing personal workspace. Agent sessions never inherit these routes.
_LOCAL_ROUTES = """
GET /api/update/state
GET /api/update/result
POST /api/update/check
POST /api/update/apply
POST /api/update/cancel
GET /api/jobs
GET /api/jobs/{job_id}
GET /api/config
POST /api/prompt/{job_id}
POST /api/clipboard-attempt
GET /api/raw
POST /api/uploads
DELETE /api/jobs/{job_id}/image
DELETE /api/jobs/{job_id}
POST /api/jobs/{job_id}/confirm
POST /api/jobs/{job_id}/cancel
POST /api/config
GET /api/onboarding/status
POST /api/folder-picker
POST /api/onboarding/data-root
GET /api/keys
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
PUT /api/gateway
POST /api/gateway/keys
PATCH /api/gateway/keys/{key_id}
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
POST /api/pricing/estimate
POST /api/gateway/check
POST /api/gateway/providers/{alias}/sync
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
POST /api/canvas/projects
PATCH /api/canvas/projects/{project_id}
POST /api/canvas/projects/export
POST /api/canvas/projects/import/inspect
POST /api/canvas/projects/import/commit
DELETE /api/canvas/projects/{project_id}
GET /api/canvas/projects/{project_id}/document
PUT /api/canvas/projects/{project_id}/document
GET /api/canvas/projects/{project_id}/agent/sessions
POST /api/canvas/projects/{project_id}/agent/sessions
GET /api/canvas/projects/{project_id}/agent/sessions/{session_id}
DELETE /api/canvas/projects/{project_id}/agent/sessions/{session_id}
PATCH /api/canvas/projects/{project_id}/agent/sessions/{session_id}
POST /api/canvas/projects/{project_id}/agent/sessions/{session_id}/messages
POST /api/canvas/projects/{project_id}/agent/sessions/{session_id}/approvals
POST /api/canvas/projects/{project_id}/agent/sessions/{session_id}/cancel
GET /api/canvas/agent/models
GET /api/canvas/agent/generation-models
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
POST /api/creation-assets/generation/from-job
POST /api/creation-assets/generation/from-canvas
POST /api/creation-assets/prompts
POST /api/creation-assets/media/from-path
POST /api/creation-assets/media/upload
PUT /api/creation-assets/{asset_id}/prompt
PUT /api/creation-assets/{asset_id}/media
POST /api/creation-assets/{asset_id}/use
DELETE /api/creation-assets/{asset_id}
GET /api/creation-assets/{asset_id}/content
GET /api/creation-assets/{asset_id}/inputs/{order}
GET /api/creation-assets/{asset_id}/staleness
POST /api/creation-assets/{asset_id}/readopt
POST /api/canvas/projects/{project_id}/creation-assets/{asset_id}/insert
POST /api/canvas/projects/{project_id}/creation-assets/{asset_id}/reproduce
GET /api/profile
PUT /api/profile
GET /api/team-libraries
POST /api/team-libraries
DELETE /api/team-libraries/{library_id}
POST /api/team-libraries/{library_id}/rescan
GET /api/team-libraries/{library_id}/assets
GET /api/team-libraries/{library_id}/assets/{entry_id}/content
GET /api/team-libraries/{library_id}/assets/{entry_id}/thumb
POST /api/team-libraries/{library_id}/assets/{entry_id}/adopt
GET /api/team-libraries/related
POST /api/team-libraries/{library_id}/share
PUT /api/team-libraries/{library_id}/assets/{asset_id}
DELETE /api/team-libraries/{library_id}/assets/{asset_id}
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
POST /api/canvas/projects/{project_id}/runs/reverse-prompt
POST /api/canvas/projects/{project_id}/runs/angle
POST /api/canvas/projects/{project_id}/runs/upscale
POST /api/canvas/projects/{project_id}/image-edits
POST /api/canvas/projects/{project_id}/runs/image-edit
POST /api/canvas/projects/{project_id}/runs/layer-decomposition
GET /api/canvas/projects/{project_id}/batch-runs
POST /api/canvas/projects/{project_id}/batch-runs/prepare
GET /api/canvas/projects/{project_id}/batch-runs/{batch_id}
POST /api/canvas/projects/{project_id}/batch-runs/{batch_id}/start
POST /api/canvas/projects/{project_id}/batch-runs/{batch_id}/cancel
POST /api/canvas/projects/{project_id}/runs/{run_id}/reverse-prompt-config
POST /api/canvas/projects/{project_id}/runs
POST /api/canvas/projects/{project_id}/runs/{run_id}/cancel
POST /api/canvas/projects/{project_id}/runs/{run_id}/resume-mj-edit
POST /api/canvas/projects/{project_id}/runs/{run_id}/candidates/{candidate_id}/dismiss
POST /api/studio/jobs
GET /events
GET /docs
GET /docs/oauth2-redirect
GET /redoc
GET /openapi.json
""".strip().splitlines()

LOCAL_MANAGEMENT = frozenset({
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
    "/api/keys/models-preview", "/api/models/order", "/api/models/mode", "/api/folder-picker", "/api/onboarding/status",
    "/api/onboarding/data-root",
    # 局域网共享：开关会让本机对局域网开端口，密钥与用量也只给本机页面（ADR-0025）。
    "/api/gateway", "/api/gateway/service", "/api/gateway/keys", "/api/gateway/keys/{key_id}",
    "/api/gateway/keys/{key_id}/revoke", "/api/usage", "/api/usage/tasks", "/api/usage/key-last-used",
    "/api/gateway/check",
    "/api/gateway/providers/{alias}/sync", "/api/gateway/options",
    "/api/gateway/tasks", "/api/gateway/tasks/{task_id}/outputs/{index}",
    "/api/gateway/providers/{alias}/me",
    "/api/model-routes/member-status", "/api/model-routes/member-status/restore",
    # 挂载团队库 = 往本机任意目录写清单并整棵扫描，同 folder-picker 只给本机页面。
    "/api/team-libraries",
    # 导入 / 删除 Agent Skill 改写数据目录里的说明文件，Agent 每轮都会读，只给本机页面。
    "/api/canvas/agent/skills/import", "/api/canvas/agent/skills/{name}",
})
# 已脱敏的 Key 列表（alias / 能力 / 掩码）是选模型的依据，网站会话也要读；增删改与 reveal 仍属管理。
# 已挂载的团队库列表同理：网站会话要读它才能浏览 / 采用。
_MANAGEMENT_READ_EXEMPT = frozenset({("GET", "/api/keys"), ("GET", "/api/team-libraries")})
# 用 POST 只因为 id 列表放不进查询串；它只读，不需要编辑租约。
_READ_POSTS = frozenset({("POST", "/api/creation-assets/staleness")})
MEDIA_ROUTES = frozenset({
    "/api/raw", "/api/images", "/api/gallery/image",
    "/api/creation-assets/{asset_id}/content",
    "/api/creation-assets/{asset_id}/inputs/{order}",
    "/api/canvas/projects/{project_id}/versions/{version_id}/media",
    "/api/canvas/projects/{project_id}/versions/{version_id}/download",
    "/api/canvas/projects/{project_id}/nodes/{node_id}/layers/download",
    "/api/team-libraries/{library_id}/assets/{entry_id}/content",
    "/api/team-libraries/{library_id}/assets/{entry_id}/thumb",
})
CANVAS_TOOLS = frozenset({
    "list-projects", "get-document", "list-models", "apply-changes", "import-media", "run",
    "get-run", "read-media",
})
LOCAL_RULES = [
    (method, path, compile_path(path)[0])
    for entry in _LOCAL_ROUTES
    for method, path in [entry.split(" ", 1)]
]


def is_media_route(path: str) -> bool:
    """媒体路由自带缓存策略（缩略图 immutable），中间件不覆盖它们的 Cache-Control。"""
    return any(template in MEDIA_ROUTES and pattern.fullmatch(path) for _, template, pattern in LOCAL_RULES)


def local_capability(method: str, path: str) -> str | None:
    for allowed_method, template, pattern in LOCAL_RULES:
        if (allowed_method == method or (
            method == "HEAD" and allowed_method == "GET" and template in MEDIA_ROUTES
        )) and pattern.fullmatch(path):
            if template in LOCAL_MANAGEMENT and (method, template) not in _MANAGEMENT_READ_EXEMPT:
                return "manage"
            if method in {"GET", "HEAD"} or (method, template) in _READ_POSTS:
                return "read"
            return "edit"
    return None
