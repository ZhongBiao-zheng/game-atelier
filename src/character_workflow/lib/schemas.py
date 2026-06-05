"""Pydantic schemas — single source of truth for Python.
对应 web/src/schema/jobs.ts，任何改动两边同步。
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class JobStatus(str, Enum):
    # PENDING_CONFIRM = Skill 已组装好调用参数、等画师在终端或 Web 点确认。
    # PENDING = 已确认 & in-flight（Skill 同步调图像服务期间停在此状态）。
    PENDING_CONFIRM = "pending_confirm"
    PENDING = "pending"
    DONE = "done"
    FAILED = "failed"


class AssetSlot(str, Enum):
    # 角色资产槽位 — 决定 characters/<id>/<slot>/ 物理路径。
    # 老 JobKind = PORTRAIT/PROMO/TURNAROUND 改名而来（2026-05-25 重构）。
    PORTRAIT = "portrait"
    PROMO = "promo"
    TURNAROUND = "turnaround"


class JobKind(str, Enum):
    # 媒体类型 — 与 AssetSlot 解耦。VIDEO 占位，runner 抛 NotImplementedError。
    IMAGE = "image"
    VIDEO = "video"


class JobParams(BaseModel):
    model_config = ConfigDict(extra="allow")
    size: str | None = None
    steps: int | None = None
    cfg_scale: float | None = None
    # 出图卡片展示用 —— 让画师在确认前看到完整调用细节
    vendor: str | None = None
    n: int | None = None
    reference_images: list[str] | None = None
    requested_size: str | None = None
    actual_size: str | None = None
    warnings: list[str] | None = None


class Job(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str
    character_id: str
    prompt: str
    submitted_at: str
    model: str
    params: JobParams
    seed: int | None
    output_paths: list[str]
    status: JobStatus
    error: str | None
    # 2026-05-25 重构：原 kind 拆成 asset_slot + kind + namespace。
    asset_slot: AssetSlot = AssetSlot.PORTRAIT
    kind: JobKind = JobKind.IMAGE
    namespace: str = "character"  # "character" | "studio"
    source_image: str | None = None  # promo/turnaround 用，绝对路径
    # Phase 3 (2026-05-22): which Key was used. Web 不能改这两个字段。
    alias: str | None = None
    provider: str | None = None


class WebEditableJobPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str | None = None
    model: str | None = None
    params: JobParams | None = None
    seed: int | None = None


class SpecPatch(BaseModel):
    content: str = Field(min_length=1)


class FeedbackPost(BaseModel):
    text: str = Field(min_length=1)
    character_id: str | None = None


class ClipboardAttempt(BaseModel):
    ts: str
    success: bool
    reason: str | None = None


class CharacterEntry(BaseModel):
    id: str
    name: str
    status: str
    latest_job_id: str | None


class ActiveCharacterFile(BaseModel):
    active_id: str | None
    updated_at: str


class Project(BaseModel):
    id: str
    slug: str
    name: str
    created_at: str


class ProjectsFile(BaseModel):
    # 项目列表 + 角色 → 项目 的归属表。未归属的角色直接不在 assignments 里。
    projects: list[Project] = []
    assignments: dict[str, str] = {}  # character_id → project_id


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class CharacterProjectAssign(BaseModel):
    project_id: str | None = None  # None = 取消归属


class TurnStage(str, Enum):
    # turn-start v4/v5：file system 探测结果
    # A = characters/ 不存在；B = 空 characters/；C = active 缺失/失效
    # D = 正常回流（active 完整且已归属项目）
    # E = active 完整但未归属任何项目（Stage E 兜底）
    A = "A"
    B = "B"
    C = "C"
    D = "D"
    E = "E"


class IntentKind(str, Enum):
    # 仅 stage D 时有值。null = 不在 stage D。
    NEW = "new"
    REVISE = "revise"
    CREATE = "create"
    SWITCH = "switch"


class RecentCharacter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    tagline: str  # spec.md 首行非空、非标题内容，≤30 字


class PendingCharacterIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    old_id: str
    display_name: str
    recommended_id: str
    spec_status: str
    project_id: str | None = None
    project_name: str | None = None
    asset_counts: dict[str, int]
    job_count: int
    has_assets: bool
    is_active: bool = False


class RecommendAction(str, Enum):
    # v4.1.0 决策表 —— 把"裸触发 default 默认出图"误推从 LLM 收回。
    RENDER_CARD = "render_card"
    ASK = "ask"
    SWITCH = "switch"
    NOOP = "noop"


class TurnStartResult(BaseModel):
    # v4.0.0 CLI 输出契约。Skill 端按 stage 分支。
    # v4.1.0：新增 recommend_action / recommend_reason / active_age_minutes
    # —— SKILL.md 按 recommend_action 分叉，intent 字段保留 debug 用。
    # v5.0.0：新增 Stage E + 三层 lessons/worldview 字段 + project_{id,slug,name}
    model_config = ConfigDict(extra="forbid")
    stage: TurnStage
    stage_reason: str
    intent: IntentKind | None
    intent_signal: str
    intent_conflict: bool
    recommend_action: RecommendAction
    recommend_reason: str
    active_age_minutes: int | None
    recent_chars: list[RecentCharacter]
    drafts: list[dict]
    active_id: str | None
    active_updated_at: str
    spec: str | None
    spec_status: str = "missing"
    pending_identity_normalizations: list[PendingCharacterIdentity] = Field(
        default_factory=list
    )
    project_id: str | None
    project_slug: str | None
    project_name: str | None
    # v5.2.0：characters 为空时 SKILL 据此决定先问项目还是直接问角色。
    has_projects: bool = False
    projects: list[dict] = Field(default_factory=list)
    project_memory: str
    lessons_workspace: str
    lessons_project: str
    lessons_kind: str
    # v5.1.0 (Phase 3): Key 选择协议 — AI 决策时读这两个字段。
    available_keys: list[dict] = Field(default_factory=list)
    preferred_alias: str | None = None
