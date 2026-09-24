"""Explicit local API capabilities; an unregistered route is never a data escape hatch."""
from __future__ import annotations

from starlette.routing import compile_path

# Local editor owns the existing personal workspace. Agent sessions never inherit these routes.
_LOCAL_ROUTES = """
GET /api/jobs
GET /api/jobs/{job_id}
GET /api/spec/{character_id}
GET /api/characters
GET /api/projects/{project_id}/characters/index
GET /api/projects/{project_id}/characters/{character_id}/workspace
PUT /api/projects/{project_id}/character-associations
GET /api/projects/{project_id}/character-associations
GET /api/home
POST /api/characters/{character_id}/rename
GET /api/active-character
GET /api/images
GET /api/config
GET /api/characters/{character_id}/canonical
POST /api/characters/{character_id}/canonical
GET /api/projects/{project_id}/ui-schemes/{scheme_id}/screens/canonical
POST /api/projects/{project_id}/ui-schemes/{scheme_id}/screens/canonical
POST /api/spec/{character_id}
POST /api/prompt/{job_id}
POST /api/feedback
POST /api/clipboard-attempt
GET /api/raw
POST /api/uploads
POST /api/characters/{character_id}/gallery/{kind}
POST /api/characters
POST /api/characters/{source_character_id}/derivatives
DELETE /api/characters/{character_id}
DELETE /api/jobs/{job_id}/image
DELETE /api/jobs/{job_id}
GET /api/projects
GET /api/projects/{project_id}/ui-schemes
POST /api/projects/{project_id}/ui-schemes
POST /api/projects/{project_id}/ui-schemes/default
GET /api/projects/{project_id}/workspaces
GET /api/projects/{project_id}/videos
GET /api/projects/{project_id}/videos/{production_id}
GET /api/projects/{project_id}/video-references
POST /api/projects/{project_id}/videos/{production_id}/references
POST /api/projects/{project_id}/videos/{production_id}/selected
POST /api/projects
GET /api/projects/index
GET /api/projects/{project_id}/gallery/media
GET /api/projects/{project_id}/gallery
POST /api/projects/reorder
POST /api/projects/{project_id}/rename
DELETE /api/projects/{project_id}
GET /api/experience
POST /api/experience
POST /api/characters/{character_id}/project
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
GET /api/gallery/recent
GET /api/gallery/screens
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
GET /api/creation-assets
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
POST /api/canvas/projects/{project_id}/runs/mask-edit
POST /api/canvas/projects/{project_id}/runs/layer-decomposition
GET /api/canvas/projects/{project_id}/batch-runs
POST /api/canvas/projects/{project_id}/batch-runs/prepare
GET /api/canvas/projects/{project_id}/batch-runs/{batch_id}
POST /api/canvas/projects/{project_id}/batch-runs/{batch_id}/start
POST /api/canvas/projects/{project_id}/batch-runs/{batch_id}/cancel
POST /api/canvas/projects/{project_id}/runs/{run_id}/reverse-prompt-config
POST /api/canvas/projects/{project_id}/runs
POST /api/canvas/projects/{project_id}/runs/{run_id}/retry
POST /api/canvas/projects/{project_id}/runs/{run_id}/cancel
POST /api/canvas/projects/{project_id}/runs/{run_id}/candidates/{candidate_id}/dismiss
GET /api/projects/{project_id}/studio-archive-targets
POST /api/studio/jobs/{job_id}/archive
POST /api/studio/jobs
GET /events
GET /docs
GET /docs/oauth2-redirect
GET /redoc
GET /openapi.json
GET /api/workshop/requests/{request_id}
GET /api/workshop/requests/{request_id}/references/{media_id}
""".strip().splitlines()

LOCAL_MANAGEMENT = frozenset({
    "/api/config", "/api/keys", "/api/keys/{alias}", "/api/keys/{alias}/reveal",
    "/api/keys/models-preview", "/api/folder-picker", "/api/onboarding/status",
    "/api/onboarding/data-root",
    # 挂载团队库 = 往本机任意目录写清单并整棵扫描，同 folder-picker 只给本机页面。
    "/api/team-libraries",
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
    "/api/workshop/requests/{request_id}/references/{media_id}",
    "/api/team-libraries/{library_id}/assets/{entry_id}/content",
    "/api/team-libraries/{library_id}/assets/{entry_id}/thumb",
})
WORKSHOP_TOOLS = frozenset({
    "list-projects", "list-targets", "get-context", "list-models", "create-target", "read-document",
    "write-document", "acknowledge-feedback", "list-media", "read-media",
    "prepare-generation", "get-generation", "withdraw-generation", "approve-generation",
    "read-lessons", "append-lesson", "list-prompt-assets", "read-prompt-asset",
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
