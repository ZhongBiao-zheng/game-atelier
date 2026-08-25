"""Pydantic schemas — single source of truth for Python.
对应 web/src/schema/jobs.ts，任何改动两边同步。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints, model_validator


class JobStatus(str, Enum):
    # PENDING_CONFIRM = Skill 已组装好调用参数、等画师在终端或 Web 点确认。
    # PENDING = 已确认 & in-flight（Skill 同步调图像服务期间停在此状态）。
    PENDING_CONFIRM = "pending_confirm"
    PENDING = "pending"
    DONE = "done"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELED = "canceled"


class AssetSlot(str, Enum):
    # 角色资产槽位 — 决定 characters/<id>/<slot>/ 物理路径。
    # 老 JobKind = PORTRAIT/PROMO/TURNAROUND 改名而来（2026-05-25 重构）。
    PORTRAIT = "portrait"
    PROMO = "promo"
    TURNAROUND = "turnaround"


class JobKind(str, Enum):
    # 产物类型 — 与 AssetSlot / namespace 解耦；Canvas 可使用四种生成 caller。
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"


Namespace = Literal["character", "studio", "ui", "video", "canvas"]


class JobParams(BaseModel):
    model_config = ConfigDict(extra="allow")
    size: str | None = None
    steps: int | None = None
    cfg_scale: float | None = None
    # 出图卡片展示用 —— 让画师在确认前看到完整调用细节
    vendor: str | None = None
    n: int | None = None
    reference_images: list[str] | None = None
    # Canvas 局部编辑专用：服务端从不可变 mask Content Version 解析，浏览器不能传路径。
    mask_image: str | None = None
    # Canvas 多角度生成专用：结构化相机参数进入 Snapshot，caller 只消费最终 prompt。
    angle_horizontal: int | None = Field(default=None, ge=-60, le=60)
    angle_pitch: int | None = Field(default=None, ge=-45, le=45)
    angle_distance: float | None = Field(default=None, ge=1, le=10)
    angle_wide: bool | None = None
    requested_size: str | None = None
    actual_size: str | None = None
    warnings: list[str] | None = None
    # 图片参数 —— 前端实际在发（Studio 提交链路），显式声明保证双端类型对齐
    ratio: str | None = None               # e.g. "16:9"
    quality: str | None = None             # low | medium | high | auto
    background: Literal["auto", "opaque", "transparent"] | None = None
    # 视频参数（kind=video）—— 做成一等公民以保证双端类型对齐
    duration: int | None = None            # 秒，1-60
    resolution: str | None = None          # 480p | 720p | 1080p
    mode: str | None = None                # kling 生成档位 std | pro（≠ frame_mode）
    frame_mode: str | None = None          # auto | first | last | firstlast
    generate_audio: bool | None = None
    watermark: bool | None = None
    reference_videos: list[str] | None = None
    reference_audios: list[str] | None = None
    # 文本生成参数（OpenAI-compatible chat/completions 与 Responses）。
    temperature: float | None = None
    max_tokens: int | None = None
    reasoning_effort: Literal["auto", "low", "medium", "high", "xhigh"] | None = None
    # 语音生成参数（OpenAI-compatible audio/speech）。
    voice: str | None = None
    speed: float | None = None
    response_format: str | None = None
    instructions: str | None = None
    # 2026-08-10 (B3): UI 页面风格候选 —— 结构锁定、只换风格时记来源关系。
    # style_variant = 画师给的风格方向标签；base_version = 结构所本的基准页文件名（如 v1.png）。
    style_variant: str | None = None
    base_version: str | None = None
    # Studio 单产物归档到项目资产时，记录不可变来源；新 Job 仍保留原 prompt / 模型 / 参数。
    archived_from_job_id: str | None = None
    archived_from_path: str | None = None
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


class CanvasActor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["user", "agent", "plugin"]
    actor_id: str | None = None


class CanvasSnapshotInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    order: int = Field(ge=0)
    source: Literal["implicit_self", "input_connection"]
    node_id: str
    version_id: str
    kind: Literal["text", "image", "video", "audio"]


class CanvasGenerationSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_version: Literal[1] = 1
    surface_node_id: str
    result_node_id: str
    mode: Literal["text", "image", "video", "audio"]
    final_prompt: str
    input_policy: Literal["all_connected", "mentions_only"]
    model: str
    provider: str
    alias: str | None = None
    normalized_params: dict[str, Any]
    inputs: list[CanvasSnapshotInput]
    mask_version_id: str | None = None
    submitted_at: str
    submitted_by: CanvasActor
    request_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


class CanvasResultCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_id: str
    index: int = Field(ge=0)
    status: Literal["pending", "succeeded", "failed", "canceled"]
    version_id: str | None = None
    error: str | None = None
    replaces_candidate_id: str | None = None
    # UI dismissal is a tombstone: Job/Snapshot/Version provenance remains auditable.
    dismissed_at: str | None = None


class CanvasJobContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str
    snapshot: CanvasGenerationSnapshot
    result_node_id: str
    candidates: list[CanvasResultCandidate]


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
    # 项目视频 job（namespace="video"）—— 一次 job 产出一支完整企划视频。
    production_id: str | None = None
    # 人工画布 job（namespace="canvas"）—— 归独立画布项目，不属于 Studio/工坊/Skill。
    canvas_project_id: str | None = None
    canvas_run: CanvasJobContext | None = None
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
    # Canvas Run lifecycle only: the runner claims a queued Job before the provider call, while a
    # stop request remains truthful even when a synchronous upstream request cannot be interrupted.
    runner_started_at: str | None = None
    cancel_requested_at: str | None = None

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
            if not self.project_id or not self.production_id:
                raise ValueError("video job requires project_id and production_id")
            if self.kind is not JobKind.VIDEO:
                raise ValueError("video namespace must use kind=video")
        elif self.production_id is not None:
            raise ValueError("production_id is only valid for namespace=video")

        if self.namespace == "canvas":
            if not self.canvas_project_id or self.canvas_run is None:
                raise ValueError("canvas job requires canvas_project_id and canvas_run")
        elif self.canvas_project_id is not None or self.canvas_run is not None:
            raise ValueError("canvas_project_id and canvas_run are only valid for namespace=canvas")
        if self.namespace != "canvas" and (
            self.runner_started_at is not None or self.cancel_requested_at is not None
        ):
            raise ValueError(
                "runner_started_at and cancel_requested_at are only valid for namespace=canvas"
            )
        return self


CanvasProjectName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=80, pattern=r"^[^\r\n]+$"),
]


class CanvasPoint(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float
    y: float


class CanvasSize(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    width: float = Field(gt=0, le=4000)
    height: float = Field(gt=0, le=4000)


class CanvasViewport(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float = 0
    y: float = 0
    zoom: float = Field(default=1, gt=0.05, le=4)


class CanvasSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    background: Literal["lines", "dots", "none"] = "none"
    show_image_info: bool = True
    show_minimap: bool = True


CanvasImageQuickToolId = Literal[
    "info",
    "delete",
    "saveAsset",
    "download",
    "copyPrompt",
    "reversePrompt",
    "replace",
    "resize",
    "maskEdit",
    "crop",
    "split",
    "upscale",
    "angle",
]


class CanvasImageToolbarPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    tool_ids: list[CanvasImageQuickToolId]
    show_labels: bool = False

    @model_validator(mode="after")
    def unique_tools(self) -> "CanvasImageToolbarPreferences":
        if len(self.tool_ids) != len(set(self.tool_ids)):
            raise ValueError("图片快捷工具不能重复")
        return self


class CanvasUiPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal[1] = 1
    revision: int = Field(default=0, ge=0)
    image_toolbar: CanvasImageToolbarPreferences
    updated_at: datetime | None = None


class CanvasUiPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: int = Field(ge=0)
    image_toolbar: CanvasImageToolbarPreferences


class CanvasGenerationDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["text", "image", "video", "audio"]
    prompt: str = Field(default="", max_length=40_000)
    input_policy: Literal["all_connected", "mentions_only"] = "all_connected"
    model: str = Field(default="", max_length=200)
    alias: str | None = Field(default=None, max_length=120)
    params: JobParams = Field(default_factory=JobParams)
    updated_at: str


def _draft_with_default_policy(value: object, policy: str) -> object:
    if isinstance(value, dict) and "input_policy" not in value:
        return {**value, "input_policy": policy}
    if isinstance(value, CanvasGenerationDraft) and "input_policy" not in value.model_fields_set:
        return value.model_copy(update={"input_policy": policy})
    return value


class CanvasContentNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_version_id: str | None = None
    generation_draft: CanvasGenerationDraft | None = None
    active_run_id: str | None = None


class CanvasTextDisplay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scale: Literal["xs", "sm", "base"] = "sm"


class CanvasTextNodeData(CanvasContentNodeData):
    display: CanvasTextDisplay = Field(default_factory=CanvasTextDisplay)


class CanvasMediaDisplay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fit: Literal["contain", "cover"] = "contain"
    free_resize: bool = False


class CanvasMediaNodeData(CanvasContentNodeData):
    display: CanvasMediaDisplay = Field(default_factory=CanvasMediaDisplay)


class CanvasConfigNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft: CanvasGenerationDraft

    @model_validator(mode="before")
    @classmethod
    def default_input_policy(cls, value: object) -> object:
        if isinstance(value, dict) and "draft" in value:
            return {**value, "draft": _draft_with_default_policy(value["draft"], "mentions_only")}
        return value


class CanvasGroupNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_node_ids: list[str] = Field(default_factory=list)


class CanvasPluginNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plugin_id: str = Field(min_length=1, max_length=120)
    node_type: str = Field(min_length=1, max_length=120)
    plugin_version: str = Field(min_length=1, max_length=80)
    data_schema_version: int = Field(ge=1)
    payload: JsonValue
    generation_draft: CanvasGenerationDraft | None = None

    @model_validator(mode="before")
    @classmethod
    def default_input_policy(cls, value: object) -> object:
        if isinstance(value, dict) and value.get("generation_draft") is not None:
            return {
                **value,
                "generation_draft": _draft_with_default_policy(
                    value["generation_draft"], "mentions_only"
                ),
            }
        return value

    @model_validator(mode="after")
    def validate_payload_size(self) -> "CanvasPluginNodeData":
        encoded = json.dumps(
            self.payload, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        if len(encoded) > 256 * 1024:
            raise ValueError("canvas plugin payload exceeds 256 KiB")
        return self


class CanvasNodeBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=120)
    position: CanvasPoint
    size: CanvasSize | None = None
    z_index: int = Field(default=0, ge=-10_000, le=10_000)


class CanvasTextNode(CanvasNodeBase):
    type: Literal["text"]
    data: CanvasTextNodeData


class CanvasImageNode(CanvasNodeBase):
    type: Literal["image"]
    data: CanvasMediaNodeData


class CanvasVideoNode(CanvasNodeBase):
    type: Literal["video"]
    data: CanvasMediaNodeData


class CanvasAudioNode(CanvasNodeBase):
    type: Literal["audio"]
    data: CanvasContentNodeData


class CanvasConfigNode(CanvasNodeBase):
    type: Literal["config"]
    data: CanvasConfigNodeData


class CanvasGroupNode(CanvasNodeBase):
    type: Literal["group"]
    data: CanvasGroupNodeData


class CanvasPluginNode(CanvasNodeBase):
    type: Literal["plugin"]
    data: CanvasPluginNodeData


CanvasNode = Annotated[
    CanvasTextNode | CanvasImageNode | CanvasVideoNode | CanvasAudioNode
    | CanvasConfigNode | CanvasGroupNode | CanvasPluginNode,
    Field(discriminator="type"),
]


class CanvasInputConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=160)
    role: Literal["input"]
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)


class CanvasGenerationRunOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["generation_run"]
    run_id: str = Field(min_length=1, max_length=160)


class CanvasLocalToolConnectionOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["local_tool"]
    operation_id: str = Field(min_length=1, max_length=160)


CanvasDerivationOrigin = Annotated[
    CanvasGenerationRunOrigin | CanvasLocalToolConnectionOrigin,
    Field(discriminator="kind"),
]


class CanvasDerivationConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=160)
    role: Literal["derivation"]
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    origin: CanvasDerivationOrigin


CanvasConnection = Annotated[
    CanvasInputConnection | CanvasDerivationConnection,
    Field(discriminator="role"),
]


class CanvasUserEditOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["user_edit"]


class CanvasUploadOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["upload"]
    upload_id: str


class CanvasUserMaskOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["user_mask"]
    source_version_id: str


class CanvasJobOutputOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["job_output"]
    job_id: str
    candidate_id: str


class CanvasImportOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["import"]
    package_id: str


class CanvasNormalizedRect(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)


class CanvasCropOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["crop"]
    rect: CanvasNormalizedRect


class CanvasSplitOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["split"]
    horizontal_lines: list[float]
    vertical_lines: list[float]
    row: int = Field(ge=0)
    column: int = Field(ge=0)


class CanvasUpscaleOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["upscale"]
    target_long_edge: int = Field(gt=0, le=4096)
    algorithm: Literal["nearest", "bilinear", "lanczos"]


CanvasLocalToolOperation = Annotated[
    CanvasCropOperation | CanvasSplitOperation | CanvasUpscaleOperation,
    Field(discriminator="kind"),
]


class CanvasLocalToolOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["local_tool"]
    operation_id: str
    source_version_id: str
    operation: CanvasLocalToolOperation


CanvasContentOrigin = Annotated[
    CanvasUserEditOrigin | CanvasUploadOrigin | CanvasUserMaskOrigin | CanvasJobOutputOrigin
    | CanvasLocalToolOrigin | CanvasImportOrigin,
    Field(discriminator="kind"),
]


class CanvasContentVersionBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: str = Field(min_length=1, max_length=160)
    created_at: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    origin: CanvasContentOrigin


class CanvasTextVersion(CanvasContentVersionBase):
    kind: Literal["text"]
    text: str = Field(max_length=40_000)


class CanvasMediaVersion(CanvasContentVersionBase):
    kind: Literal["image", "video", "audio"]
    path: str = Field(min_length=1)
    mime_type: str = Field(min_length=1, max_length=120)
    bytes: int = Field(ge=0)
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    duration_ms: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_owned_relative_path(self) -> "CanvasMediaVersion":
        if "\\" in self.path or self.path.startswith("/"):
            raise ValueError("canvas media path must be project-relative")
        parts = self.path.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise ValueError("canvas media path must be normalized")
        if parts[0] not in {"uploads", "derived", "outputs"}:
            raise ValueError("canvas media path is outside owned project directories")
        if self.origin.kind == "upload" and (
            parts[0] != "uploads" or parts[-1].rsplit(".", 1)[0] != self.origin.upload_id
        ):
            raise ValueError("canvas upload path does not match its origin")
        if self.origin.kind == "local_tool" and (
            len(parts) < 3 or parts[0] != "derived" or parts[1] != self.origin.operation_id
        ):
            raise ValueError("canvas derived path does not match its operation")
        if self.origin.kind == "job_output" and (
            len(parts) < 3 or parts[0] != "outputs" or parts[1] != self.origin.job_id
        ):
            raise ValueError("canvas output path does not match its job")
        return self


CanvasContentVersion = Annotated[
    CanvasTextVersion | CanvasMediaVersion,
    Field(discriminator="kind"),
]


class CanvasDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[2] = 2
    project_id: str = Field(min_length=1)
    revision: int = Field(default=0, ge=0)
    viewport: CanvasViewport = Field(default_factory=CanvasViewport)
    settings: CanvasSettings = Field(default_factory=CanvasSettings)
    nodes: list[CanvasNode] = Field(default_factory=list, max_length=10_000)
    connections: list[CanvasConnection] = Field(default_factory=list, max_length=20_000)
    content_versions: dict[str, CanvasContentVersion] = Field(default_factory=dict)
    updated_at: str

    @model_validator(mode="after")
    def validate_graph_references(self) -> "CanvasDocument":
        node_ids = [node.id for node in self.nodes]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError("canvas node ids must be unique")
        edge_ids = [edge.id for edge in self.connections]
        if len(edge_ids) != len(set(edge_ids)):
            raise ValueError("canvas connection ids must be unique")
        edge_endpoints = [
            (edge.role, edge.source_node_id, edge.target_node_id)
            for edge in self.connections
        ]
        if len(edge_endpoints) != len(set(edge_endpoints)):
            raise ValueError("canvas connections cannot duplicate role and endpoints")
        nodes_by_id = {node.id: node for node in self.nodes}
        for version_id, version in self.content_versions.items():
            if version_id != version.version_id:
                raise ValueError("canvas content version key must match version_id")
            if version.origin.kind == "user_mask":
                source = self.content_versions.get(version.origin.source_version_id)
                if (
                    version.kind != "image"
                    or source is None
                    or source.kind != "image"
                    or (
                        version.width is not None
                        and source.width is not None
                        and version.width != source.width
                    )
                    or (
                        version.height is not None
                        and source.height is not None
                        and version.height != source.height
                    )
                ):
                    raise ValueError("canvas user mask references an incompatible source version")
        group_members: set[str] = set()
        for node in self.nodes:
            if node.type in {"text", "image", "video", "audio"}:
                version_id = node.data.current_version_id
                if version_id is not None:
                    version = self.content_versions.get(version_id)
                    if version is None or version.kind != node.type:
                        raise ValueError("canvas content node references an incompatible version")
            if node.type == "group":
                for member_id in node.data.member_node_ids:
                    member = nodes_by_id.get(member_id)
                    if member is None or member.type == "group" or member_id in group_members:
                        raise ValueError("canvas group membership is invalid")
                    group_members.add(member_id)
        for edge in self.connections:
            if edge.source_node_id not in nodes_by_id or edge.target_node_id not in nodes_by_id:
                raise ValueError("canvas connection references a missing node")
            if edge.source_node_id == edge.target_node_id:
                raise ValueError("canvas connection cannot target itself")
            source = nodes_by_id[edge.source_node_id]
            target = nodes_by_id[edge.target_node_id]
            if source.type == "group" or target.type == "group":
                raise ValueError("canvas group nodes cannot be connection endpoints")
            if edge.role == "input":
                if source.type in {"config", "plugin"}:
                    raise ValueError("canvas input source cannot provide content")
                if target.type == "plugin":
                    raise ValueError("canvas plugin connections require a verified capability manifest")
        if len(self.model_dump_json().encode("utf-8")) > 25 * 1024 * 1024:
            raise ValueError("canvas document exceeds 25 MiB")
        return self


class CanvasProject(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[2] = 2
    project_id: str
    name: CanvasProjectName
    created_at: str
    updated_at: str


class CanvasProjectCover(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: str


class CanvasProjectSummary(CanvasProject):
    cover: CanvasProjectCover | None = None
    node_count: int = Field(ge=0)
    connection_count: int = Field(ge=0)


class CanvasProjectList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projects: list[CanvasProjectSummary]


class CanvasProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: CanvasProjectName = "未命名画布"


class CanvasProjectRename(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: CanvasProjectName


CanvasAgentSessionId = Annotated[
    str,
    StringConstraints(pattern=r"^session-[a-z0-9-]{8,64}$"),
]
CanvasAgentMessageId = Annotated[
    str,
    StringConstraints(pattern=r"^message-[a-z0-9-]{8,64}$"),
]

_CANVAS_AGENT_PRIVATE_TEXT = re.compile(
    r"(?:"
    r"data:[a-z0-9.+-]+/[a-z0-9.+-]+;"
    r"|file://"
    r"|(?:^|[\s\"'`(])(?:~|\.{1,2})[/\\][^\s\"'`)]+"
    r"|(?:^|[\s\"'`(])/(?!api(?:/|\b)|/)[^\s\"'`)]+(?:/[^\s\"'`)]+)+"
    r"|(?:^|[\s\"'`(])(?:[A-Za-z0-9._-]+/)+[A-Za-z0-9._-]+\."
    r"(?:aac|gif|jpeg|jpg|json|m4a|md|mov|mp3|mp4|ogg|png|txt|wav|webm|webp)\b"
    r"|[A-Za-z]:[/\\][^\s\"'`)]+"
    r"|\\\\[^\\\s]+\\[^\s\"'`)]+"
    r"|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"
    r"|\b(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+"
    r"|\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s,;]+"
    r"|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}"
    r")",
    re.IGNORECASE,
)


def _reject_canvas_agent_private_text(*values: str | None) -> None:
    if any(
        value is not None and _CANVAS_AGENT_PRIVATE_TEXT.search(value)
        for value in values
    ):
        raise ValueError(
            "canvas agent state cannot persist secrets, local paths, or data URLs"
        )


class CanvasAgentTokenUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


class CanvasAgentReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reference_id: str = Field(min_length=1, max_length=160)
    kind: Literal["node", "content"]
    node_id: str | None = Field(default=None, min_length=1, max_length=120)
    version_id: str | None = Field(default=None, min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=120)

    @model_validator(mode="after")
    def validate_reference_target(self) -> "CanvasAgentReference":
        if self.kind == "node" and self.node_id is None:
            raise ValueError("canvas agent node reference requires node_id")
        if self.kind == "content" and self.version_id is None:
            raise ValueError("canvas agent content reference requires version_id")
        _reject_canvas_agent_private_text(
            self.reference_id,
            self.node_id,
            self.version_id,
            self.title,
        )
        return self


class CanvasAgentMessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant", "system", "tool", "error"]
    title: str | None = Field(default=None, min_length=1, max_length=160)
    text: str = Field(default="", max_length=200_000)
    reasoning_summary: str | None = Field(default=None, max_length=40_000)
    turn_id: str | None = Field(default=None, min_length=1, max_length=160)
    references: list[CanvasAgentReference] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def reject_private_payloads(self) -> "CanvasAgentMessageCreate":
        _reject_canvas_agent_private_text(
            self.title,
            self.text,
            self.reasoning_summary,
            self.turn_id,
        )
        return self


class CanvasAgentMessage(CanvasAgentMessageCreate):
    message_id: CanvasAgentMessageId
    sequence: int = Field(ge=1)
    created_at: str


class CanvasAgentSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    revision: int = Field(default=0, ge=0)
    sequence: int = Field(default=0, ge=0)
    session_id: CanvasAgentSessionId
    project_id: str = Field(pattern=r"^canvas-[a-z0-9-]{8,64}$")
    title: CanvasProjectName
    status: Literal["idle", "running", "interrupted", "failed"] = "idle"
    model: str | None = Field(default=None, min_length=1, max_length=160)
    effort: Literal["low", "medium", "high", "xhigh"] | None = None
    token_usage: CanvasAgentTokenUsage = Field(default_factory=CanvasAgentTokenUsage)
    messages: list[CanvasAgentMessage] = Field(default_factory=list, max_length=20_000)
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def validate_message_sequence(self) -> "CanvasAgentSession":
        _reject_canvas_agent_private_text(self.title, self.model)
        message_ids = [message.message_id for message in self.messages]
        sequences = [message.sequence for message in self.messages]
        if len(message_ids) != len(set(message_ids)) or len(sequences) != len(set(sequences)):
            raise ValueError("canvas agent message ids and sequences must be unique")
        if sequences != sorted(sequences):
            raise ValueError("canvas agent messages must be stored in sequence order")
        if sequences and sequences[-1] > self.sequence:
            raise ValueError("canvas agent session sequence is behind its messages")
        return self


class CanvasAgentSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: CanvasProjectName = "新对话"


class CanvasAgentSessionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: CanvasAgentSessionId
    project_id: str = Field(pattern=r"^canvas-[a-z0-9-]{8,64}$")
    title: CanvasProjectName
    status: Literal["idle", "running", "interrupted", "failed"]
    revision: int = Field(ge=0)
    sequence: int = Field(ge=0)
    message_count: int = Field(ge=0)
    created_at: str
    updated_at: str


class CanvasAgentSessionList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessions: list[CanvasAgentSessionSummary]
    corrupt_session_ids: list[CanvasAgentSessionId]


class CanvasProjectExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_ids: list[str] = Field(min_length=1, max_length=100)


class CanvasProjectDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    confirm_name: CanvasProjectName


class CanvasPackageCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=12, max_length=100, pattern=r"^[a-z0-9-]+$")


class CanvasPackageImportResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projects: list[CanvasProject]


class CanvasUploadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: CanvasMediaVersion
    filename: str
    document: CanvasDocument


CanvasSplitLine = Annotated[float, Field(gt=0, lt=1)]


class CanvasCropMediaOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["crop"]
    rect: CanvasNormalizedRect


class CanvasSplitMediaOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["split"]
    horizontal_lines: list[CanvasSplitLine] = Field(min_length=1, max_length=11)
    vertical_lines: list[CanvasSplitLine] = Field(min_length=1, max_length=11)


class CanvasUpscaleMediaOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["upscale"]
    target_long_edge: Literal[1024, 2048, 3072, 4096]
    algorithm: Literal["nearest", "bilinear", "lanczos"]


CanvasMediaOperation = Annotated[
    CanvasCropMediaOperation | CanvasSplitMediaOperation | CanvasUpscaleMediaOperation,
    Field(discriminator="kind"),
]


class CanvasMediaOperationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    source_node_id: str = Field(min_length=1, max_length=120)
    source_version_id: str = Field(min_length=1, max_length=160)
    operation: CanvasMediaOperation


class CanvasMediaOperationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: str
    document: CanvasDocument
    created_version_ids: list[str]
    created_node_ids: list[str]


class CanvasRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    requested_count: int = Field(default=1, ge=1, le=4)


class CanvasReversePromptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)


class CanvasMaskEditCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    requested_count: int = Field(default=1, ge=1, le=4)


class CanvasAngleRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    requested_count: int = Field(default=1, ge=1, le=4)
    horizontal_angle: int = Field(default=0, ge=-60, le=60)
    pitch_angle: int = Field(default=9, ge=-45, le=45)
    camera_distance: float = Field(default=4.8, ge=1, le=10)
    wide_angle: bool = False


class CanvasRunResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job: Job
    document: CanvasDocument


class CanvasRunRetry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["original", "current"]
    expected_revision: int = Field(ge=0)
    candidate_id: str | None = Field(default=None, min_length=1, max_length=160)


class CanvasCandidateDismiss(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)


class CanvasReversePromptConfigCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)


SidecarItem = TypeVar("SidecarItem")


class RevisionedSidecar(BaseModel, Generic[SidecarItem]):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    revision: int = Field(default=0, ge=0)
    updated_at: str
    items: list[SidecarItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_unique_item_identity(self) -> "RevisionedSidecar[SidecarItem]":
        if self.items and isinstance(self.items[0], CanvasLibraryAsset):
            asset_ids = [item.asset_id for item in self.items]
            version_ids = [item.version_id for item in self.items]
            if len(asset_ids) != len(set(asset_ids)):
                raise ValueError("canvas asset ids must be unique")
            if len(version_ids) != len(set(version_ids)):
                raise ValueError("each canvas content version can have at most one library entry")
        if self.items and isinstance(self.items[0], CanvasPrompt):
            prompt_ids = [item.prompt_id for item in self.items]
            if len(prompt_ids) != len(set(prompt_ids)):
                raise ValueError("canvas prompt ids must be unique")
        return self


class CanvasLibraryAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(min_length=1, max_length=160)
    version_id: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=120)
    tags: list[str] = Field(default_factory=list)


class CanvasPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt_id: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=40_000)
    tags: list[str] = Field(default_factory=list)
    source: Literal["local", "public"]


class CanvasLibraryAssetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=20)


class CanvasLibraryAssetPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=120)
    tags: list[str] | None = Field(default=None, max_length=20)


class CanvasPromptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=40_000)
    tags: list[str] = Field(default_factory=list, max_length=20)


class CanvasPromptPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=120)
    content: str | None = Field(default=None, min_length=1, max_length=40_000)
    tags: list[str] | None = Field(default=None, max_length=20)


class CanvasLibraryInsertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position: CanvasPoint


class CanvasPluginState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: int = Field(ge=1)
    revision: int = Field(default=0, ge=0)
    plugin_id: str = Field(min_length=1, max_length=120)
    plugin_version: str = Field(min_length=1, max_length=80)
    data: JsonValue

    @model_validator(mode="after")
    def validate_data_size(self) -> "CanvasPluginState":
        encoded = json.dumps(
            self.data, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        if len(encoded) > 1024 * 1024:
            raise ValueError("canvas plugin state exceeds 1 MiB")
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
    versions: int
    selected: int
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
    prompt: str = ""
    versions: list[str]
    selected: str | None = None
    planned_reference_images: list[str] = Field(default_factory=list)
    history: list[ProjectVideoJobRecord] = Field(default_factory=list)


class ProjectVideosResponse(BaseModel):
    productions: list[ProjectVideoProduction]


VideoReferenceKind = Literal["character", "ui_screen"]


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


class VideoReferencesSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paths: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def paths_are_unique(self) -> "VideoReferencesSet":
        if len(self.paths) != len(set(self.paths)):
            raise ValueError("paths must not contain duplicates")
        return self


class VideoReferencesResponse(BaseModel):
    paths: list[str]


class VideoReferencesFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paths: list[str] = Field(default_factory=list)


class VideoSelectedResponse(BaseModel):
    path: str | None = None


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
class CharacterDerivative(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_character_id: str = Field(min_length=1)
    source_character_name: str = Field(min_length=1)
    source_paths: list[str] = Field(default_factory=list)
    created_at: str


class CharacterEntry(BaseModel):
    id: str
    name: str
    status: str
    latest_job_id: str | None
    # 名册缩略图：characters/<id>/portrait/ 下最新图片的 data-root 相对路径（无立绘为 None）
    thumbnail: str | None = None
    derivative: CharacterDerivative | None


class CharacterAssociationUiTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["ui"] = "ui"
    scheme_id: str
    screen_id: str


class CharacterAssociationVideoTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["video"] = "video"
    production_id: str


CharacterAssociationTarget = Annotated[
    CharacterAssociationUiTarget | CharacterAssociationVideoTarget,
    Field(discriminator="kind"),
]


class CharacterAssociationItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    character_id: str
    target: CharacterAssociationTarget


class CharacterAssociationsFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[CharacterAssociationItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def items_are_unique(self) -> "CharacterAssociationsFile":
        keys = [
            (item.character_id, item.target.model_dump_json())
            for item in self.items
        ]
        if len(keys) != len(set(keys)):
            raise ValueError("character associations must not contain duplicates")
        return self


class CharacterAssociationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    character_id: str
    target: CharacterAssociationTarget
    associated: bool


class CharacterAssetGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slot: AssetSlot
    count: int
    canonical: CanonicalStatusEntry | None = None
    media: list[GalleryMedia] = Field(default_factory=list)


class CharacterRelatedObject(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: CharacterAssociationTarget
    title: str
    detail: str
    source: Literal["auto", "manual", "both"]
    featured_path: str | None = None
    count: int
    media: list[GalleryMedia] = Field(default_factory=list)


class CharacterWorkspaceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    character: CharacterEntry
    assets: list[CharacterAssetGroup]
    related: list[CharacterRelatedObject]
    recent_media: list[GalleryMedia]


class CharacterIndexItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    character: CharacterEntry
    cover_path: str | None
    activity_at: str


class CharacterIndexResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[CharacterIndexItem]


class CharacterDerivativeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: CharacterName
    source_paths: list[str] = Field(default_factory=list, max_length=40)


class CharacterDerivativeContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_character_id: str
    source_character_name: str
    source_paths: list[str]
    asset_slot: str


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
    output_kind: Literal["version"] = "version"


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
    derivative: CharacterDerivativeContext | None = None
    # v5.4.0 (A2): active 角色定稿 ← characters/<id>/canonical.json（promo/turnaround 选参考图用）。
    canonical: dict = Field(default_factory=dict)
