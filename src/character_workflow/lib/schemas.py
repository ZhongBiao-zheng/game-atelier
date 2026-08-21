"""Pydantic schemas — single source of truth for Python.
对应 web/src/schema/jobs.ts，任何改动两边同步。
"""
from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


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
    # 媒体类型 — 与 AssetSlot / namespace 解耦；runner 依此分派图片或视频 caller。
    IMAGE = "image"
    VIDEO = "video"


Namespace = Literal["character", "studio", "ui", "video"]


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
    # 图片参数 —— 前端实际在发（Studio 提交链路），显式声明保证双端类型对齐
    ratio: str | None = None               # e.g. "16:9"
    quality: str | None = None             # low | medium | high | auto
    # 视频参数（kind=video）—— 做成一等公民以保证双端类型对齐
    duration: int | None = None            # 秒，1-60
    resolution: str | None = None          # 480p | 720p | 1080p
    mode: str | None = None                # kling 生成档位 std | pro（≠ frame_mode）
    frame_mode: str | None = None          # auto | first | last | firstlast
    generate_audio: bool | None = None
    reference_videos: list[str] | None = None
    reference_audios: list[str] | None = None
    # 2026-08-10 (B3): UI 页面风格候选 —— 结构锁定、只换风格时记来源关系。
    # style_variant = 画师给的风格方向标签；base_version = 结构所本的基准页文件名（如 v1.png）。
    style_variant: str | None = None
    base_version: str | None = None
    # Midjourney 专属（family=midjourney）—— 与 web/src/schema/jobs.ts::JobParams 同步。
    # MJ 的 body 没有 size / quality 字段，一切控制都在 prompt 尾部的 flag 里，由 mj_image
    # caller 拼接：prompt 保持画师原文，换模型时不残留 flag。比例复用上面的 ratio 字段
    # （拼成 --ar），速度档复用 mode（MJ: FAST|RELAX|TURBO，与 kling 的 std|pro 各读各的，
    # 一个 job 只属于一个模型）。
    bot_type: str | None = None       # MID_JOURNEY | NIJI_JOURNEY（niji 走 botType 不走 flag）
    mj_version: str | None = None     # --v 7 / 6.1
    mj_stylize: int | None = None     # --stylize 0-1000
    mj_chaos: int | None = None       # --chaos 0-100
    mj_weird: int | None = None       # --weird 0-3000
    mj_seed: int | None = None        # --seed
    mj_no: str | None = None          # --no 排除词，逗号分隔
    mj_tile: bool | None = None       # --tile 无缝平铺
    mj_iw: float | None = None        # --iw 垫图权重 0-3
    # 三种参考图：值是本地路径或公网 URL（caller 会把本地文件经 OSS 转成直链再拼 flag）。
    # 垫图不在这里 —— 它走 reference_images → body 的 base64Array。
    mj_sref: list[str] | None = None  # --sref 风格参考
    mj_sw: int | None = None          # --sw 0-1000
    mj_cref: list[str] | None = None  # --cref 角色参考
    mj_cw: int | None = None          # --cw 0-100
    mj_oref: list[str] | None = None  # --oref Omni Reference
    mj_ow: int | None = None          # --ow 0-1000
    # caller 回写：本次真实拼出的 flag 串（如 "--ar 16:9 --v 8.2 --chaos 10"），Web 只读展示
    mj_flags: str | None = None


class Job(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str
    character_id: str
    prompt: str
    submitted_at: str
    model: str
    params: JobParams
    output_paths: list[str]
    status: JobStatus
    error: str | None
    # 2026-05-25 重构：原 kind 拆成 asset_slot + kind + namespace。
    asset_slot: AssetSlot = AssetSlot.PORTRAIT
    kind: JobKind = JobKind.IMAGE
    namespace: Namespace = "character"
    source_image: str | None = None  # promo/turnaround 用，绝对路径
    # UI 页面 job（namespace="ui"）—— 资产归项目中的明确方案，不归角色。
    # 三字段决定输出目录 projects/<slug>/ui/<scheme_id>/screens/<screen_id>/；Web 不能改。
    project_id: str | None = None
    ui_scheme_id: str | None = None
    screen_id: str | None = None
    # 项目视频 job（namespace="video"）—— 产物归项目企划下的单个镜头。
    production_id: str | None = None
    shot_id: str | None = None
    # Phase 3 (2026-05-22): which Key was used. Web 不能改这两个字段。
    alias: str | None = None
    provider: str | None = None
    # 2026-06-10: retry-job 克隆 failed job 时指回原 job_id；原 job 错误记录保留。
    retry_of: str | None = None
    # 2026-06-12: 出图进度真实卡点（视频 caller 经 job_runner 回写；Web 不能改）。
    # sent=任务已全部提交上游；downloading=任务成功、产物下载中。终态时清空。
    progress_phase: Literal["sent", "downloading"] | None = None
    # 2026-07-08: 出图完成时间戳（update_job_status 在 DONE/FAILED 终态回写；Web 不能改）。
    # Studio 卡片用它算出图耗时（completed_at − submitted_at）+ 展示生成时间。旧 job 无此字段=None。
    completed_at: str | None = None

    @model_validator(mode="after")
    def validate_namespace_ownership(self) -> "Job":
        if self.namespace == "ui":
            if not self.project_id or not self.ui_scheme_id or not self.screen_id:
                raise ValueError("ui job requires project_id, ui_scheme_id and screen_id")
            if self.kind is not JobKind.IMAGE:
                raise ValueError("ui job must use kind=image")
        elif self.ui_scheme_id is not None or self.screen_id is not None:
            raise ValueError("ui_scheme_id and screen_id are only valid for namespace=ui")

        if self.namespace == "video":
            if not self.project_id or not self.production_id or not self.shot_id:
                raise ValueError(
                    "video job requires project_id, production_id and shot_id"
                )
            if self.kind is not JobKind.VIDEO:
                raise ValueError("video namespace must use kind=video")
        elif self.production_id is not None or self.shot_id is not None:
            raise ValueError("production_id and shot_id are only valid for namespace=video")
        return self


class WebEditableJobPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str | None = None
    params: JobParams | None = None


class ArtWorkspaceSummary(BaseModel):
    characters: int
    canonical: int
    stale: int


class UiScreenSummary(BaseModel):
    screen_id: str
    name: str
    category: str
    priority: str
    status: str
    dependency: str
    purpose: str = ""
    brief_summary: str = ""


class UiWorkspaceSummary(BaseModel):
    scheme_id: str
    anchors: dict[str, str]
    anchors_approved: int
    style_status: str
    has_ui_style: bool
    screen_map_status: str
    screens: int
    versions: int
    canonical: int
    stale: int
    screen_items: list[UiScreenSummary]
    next_action: str
    next_command: str


class VideoWorkspaceSummary(BaseModel):
    productions: int
    shots: int
    selected_shots: int
    exports: int
    next_action: str


class ProjectWorkspaceSummary(BaseModel):
    project_id: str
    art: ArtWorkspaceSummary
    ui: UiWorkspaceSummary
    video: VideoWorkspaceSummary


class ProjectVideoJobRecord(BaseModel):
    job_id: str
    submitted_at: str
    completed_at: str | None = None
    status: JobStatus
    prompt: str
    model: str
    params: JobParams


class ProjectVideoShot(BaseModel):
    shot_id: str
    purpose: str = ""
    duration: str = ""
    status: str = "planned"
    versions: list[str]
    selected: str | None = None
    planned_reference_images: list[str] = Field(default_factory=list)
    history: list[ProjectVideoJobRecord] = Field(default_factory=list)


class ProjectVideoBrief(BaseModel):
    goal: str = ""
    platform: str = ""
    ratio: str = ""
    duration: str = ""
    sound: str = ""


class ProjectVideoProduction(BaseModel):
    production_id: str
    title: str
    type: str
    status: str
    brief: ProjectVideoBrief
    shots: list[ProjectVideoShot]
    exports: list[str]


class ProjectVideosResponse(BaseModel):
    productions: list[ProjectVideoProduction]


VideoReferenceKind = Literal["character", "character_variant", "ui_screen"]


class ProjectVideoReferenceCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: VideoReferenceKind
    asset_id: str
    label: str
    detail: str
    path: str
    scheme_id: str | None = None
    stale: bool = False


class ProjectVideoReferencesResponse(BaseModel):
    candidates: list[ProjectVideoReferenceCandidate]


class VideoShotReferencesSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paths: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def paths_are_unique(self) -> "VideoShotReferencesSet":
        if len(self.paths) != len(set(self.paths)):
            raise ValueError("paths must not contain duplicates")
        return self


class VideoShotReferencesResponse(BaseModel):
    paths: list[str]


class VideoReferencesFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shots: dict[str, list[str]] = Field(default_factory=dict)


class VideoSelectedResponse(BaseModel):
    shots: dict[str, str]


class SpecPatch(BaseModel):
    content: str = Field(min_length=1)


class FeedbackPost(BaseModel):
    text: str = Field(min_length=1)
    character_id: str = Field(min_length=1, pattern=r"^[^\r\n]+$")


class ClipboardAttempt(BaseModel):
    ts: str
    success: bool
    reason: str | None = None


CharacterName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=80, pattern=r"^[^\r\n]+$"),
]
CharacterVariantDifference = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=1000),
]


class CharacterVariant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_character_id: str = Field(min_length=1)
    difference: CharacterVariantDifference
    created_at: str


class CharacterEntry(BaseModel):
    id: str
    name: str
    status: str
    latest_job_id: str | None
    # 名册缩略图：characters/<id>/portrait/ 下最新图片的 data-root 相对路径（无立绘为 None）
    thumbnail: str | None = None
    variant: CharacterVariant | None


class CharacterVariantCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: CharacterName
    difference: CharacterVariantDifference
    folder_id: str | None = None


class CharacterVariantContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_character_id: str
    parent_name: str
    parent_identity_anchor: str
    difference: str
    asset_slot: str
    parent_canonical: dict


class ActiveCharacterFile(BaseModel):
    active_id: str | None
    updated_at: str


class Project(BaseModel):
    id: str
    slug: str
    name: str
    created_at: str


class GalleryArtTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["art"] = "art"
    character_id: str
    asset_slot: AssetSlot


class GalleryUiTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["ui"] = "ui"
    scheme_id: str
    screen_id: str


class GalleryVideoTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["video"] = "video"
    production_id: str
    shot_id: str | None = None
    output_kind: Literal["shot", "export"]


GalleryTarget = Annotated[
    GalleryArtTarget | GalleryUiTarget | GalleryVideoTarget,
    Field(discriminator="kind"),
]


class GalleryMedia(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    media_type: Literal["image", "video"]
    produced_at: str
    title: str
    detail: str
    job_id: str | None = None
    target: GalleryTarget


class ProjectGalleryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[GalleryMedia]
    next_cursor: str | None = None


class ProjectIndexItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project: Project
    cover_paths: list[str]
    activity_at: str


class ProjectIndexResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ProjectIndexItem]


class ProjectsFile(BaseModel):
    # 项目列表 + 角色 → 项目 的归属表。未归属的角色直接不在 assignments 里。
    projects: list[Project] = []
    assignments: dict[str, str] = {}  # character_id → project_id


ProjectFolderItemKind = Literal["character", "ui_scheme", "ui_screen", "video_production"]
ProjectFolderName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=60),
]


class ProjectFolderItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: ProjectFolderItemKind
    asset_id: str = Field(min_length=1)
    scheme_id: str | None = None

    @model_validator(mode="after")
    def validate_ui_identity(self) -> "ProjectFolderItem":
        if self.kind == "ui_screen" and not self.scheme_id:
            raise ValueError("ui_screen folder item requires scheme_id")
        if self.kind != "ui_screen" and self.scheme_id is not None:
            raise ValueError("scheme_id is only valid for ui_screen folder items")
        return self


UiSchemeName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=60),
]


class UiScheme(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: UiSchemeName
    created_at: str


class UiSchemesFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    default_scheme_id: str
    schemes: list[UiScheme]


class UiSchemeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: UiSchemeName
    source_scheme_id: str | None = None
    copy_style: bool = False
    copy_screen_map: bool = False
    screen_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def copy_requires_source(self) -> "UiSchemeCreate":
        if (self.copy_style or self.copy_screen_map or self.screen_ids) and not self.source_scheme_id:
            raise ValueError("copy options require source_scheme_id")
        if len(self.screen_ids) != len(set(self.screen_ids)):
            raise ValueError("screen_ids must not contain duplicates")
        return self


class UiSchemeDefaultSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scheme_id: str = Field(min_length=1)


class ProjectFolder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    note: str = ""
    created_at: str
    items: list[ProjectFolderItem] = Field(default_factory=list)


class ProjectFoldersFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    folders: list[ProjectFolder] = Field(default_factory=list)


class ProjectFolderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ProjectFolderName
    note: str = Field(default="", max_length=240)


class ProjectFolderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ProjectFolderName
    note: str = Field(max_length=240)


class ProjectFolderReorder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ordered_ids: list[str]

    @model_validator(mode="after")
    def ordered_ids_are_unique(self) -> "ProjectFolderReorder":
        if len(self.ordered_ids) != len(set(self.ordered_ids)):
            raise ValueError("ordered_ids must not contain duplicates")
        return self


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class CharacterProjectAssign(BaseModel):
    project_id: str | None = None  # None = 取消归属


class CanonicalEntry(BaseModel):
    # A2（2026-08-10）：单 slot 定稿记录。path 为 data-root 相对路径。
    # spec_fingerprint = 写入时 spec.md visual_dna+anchors 内容 hash（A3 stale 检测用）。
    # style_fingerprint = 写入时所属项目 style.md 内容 hash（A3；未归属项目 → ""）。
    model_config = ConfigDict(extra="forbid")
    path: str
    set_at: str
    spec_fingerprint: str = ""
    style_fingerprint: str = ""


class CanonicalFile(BaseModel):
    # characters/<id>/canonical.json —— 每 slot 至多一张定稿。
    model_config = ConfigDict(extra="forbid")
    portrait: CanonicalEntry | None = None
    promo: CanonicalEntry | None = None
    turnaround: CanonicalEntry | None = None


class CanonicalStatusEntry(CanonicalEntry):
    # A3：API 响应用的计算态 —— 存储指纹 vs 当前指纹比对结果，不落盘。
    # 存储指纹为 ""（旧数据 / 无 spec / 未归属项目）时无从比对，按不 stale 处理。
    spec_stale: bool = False
    style_stale: bool = False


class CanonicalStatusFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    portrait: CanonicalStatusEntry | None = None
    promo: CanonicalStatusEntry | None = None
    turnaround: CanonicalStatusEntry | None = None


class CanonicalSet(BaseModel):
    # POST /api/characters/{id}/canonical 请求体。path=None 表示取消该 slot 定稿。
    model_config = ConfigDict(extra="forbid")
    slot: AssetSlot
    path: str | None = None


class ScreenCanonicalEntry(BaseModel):
    # B3（2026-08-10）：单个 screen 的定稿记录。path 为 data-root 相对路径。
    # style_fingerprint = 写入时项目基线 + UI 方案 style.md 的组合 hash。
    model_config = ConfigDict(extra="forbid")
    path: str
    set_at: str
    style_variant: str = ""
    style_fingerprint: str = ""


class ScreenCanonicalFile(BaseModel):
    # projects/<slug>/ui/<scheme>/screens/canonical.json —— 每页至多一张定稿。
    model_config = ConfigDict(extra="forbid")
    screens: dict[str, ScreenCanonicalEntry] = Field(default_factory=dict)


class ScreenCanonicalStatusEntry(ScreenCanonicalEntry):
    # A3：API 响应用的计算态，不落盘。存储指纹为 "" 时按不 stale 处理。
    style_stale: bool = False


class ScreenCanonicalStatusFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    screens: dict[str, ScreenCanonicalStatusEntry] = Field(default_factory=dict)


class ScreenCanonicalSet(BaseModel):
    # 方案 canonical 端点请求体。path=None 表示取消该 screen 定稿。
    model_config = ConfigDict(extra="forbid")
    screen_id: str
    path: str | None = None


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
    # v5.3.0：经验沉淀闭环 —— 待沉淀的高分/喜欢角色图，每条 {path, rating, kind}。
    pending_distill: list[dict] = Field(default_factory=list)
    # v5.2.0：characters 为空时 SKILL 据此决定先问项目还是直接问角色。
    has_projects: bool = False
    projects: list[dict] = Field(default_factory=list)
    # v5.3.0：项目经验/世界观 ← projects/<slug>/worldview.md（Web「项目经验」页可编辑）。
    # 项目级出图经验改由 lessons_project（kind 段）承载，不再返回 MEMORY.md 全文。
    project_worldview: str = ""
    lessons_workspace: str
    lessons_project: str
    lessons_kind: str
    # v5.1.0 (Phase 3): Key 选择协议 — AI 决策时读这两个字段。
    available_keys: list[dict] = Field(default_factory=list)
    preferred_alias: str | None = None
    # v5.4.0 (A1): 项目风格契约全文 ← projects/<slug>/style.md（无归属 / 无契约 → ""）。
    project_style: str = ""
    variant: CharacterVariantContext | None = None
    # v5.4.0 (A2): active 角色定稿 ← characters/<id>/canonical.json（promo/turnaround 选参考图用）。
    canonical: dict = Field(default_factory=dict)
