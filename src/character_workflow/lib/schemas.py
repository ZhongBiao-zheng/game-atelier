"""Pydantic schemas — single source of truth for Python.
对应 web/src/schema/jobs.ts，任何改动两边同步。
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Generic, Literal, TypeVar

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    field_validator,
    model_serializer,
    model_validator,
)


from character_workflow.lib.collab_run_state import CanvasCollabRun


class JobStatus(str, Enum):
    # PENDING_CONFIRM = Skill 已组装好调用参数、等画师在终端或 Web 点确认。
    # PENDING = 已确认 & in-flight（Skill 同步调图像服务期间停在此状态）。
    PENDING_CONFIRM = "pending_confirm"
    PENDING = "pending"
    DONE = "done"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELED = "canceled"


class JobKind(str, Enum):
    # 产物类型；Canvas 可使用四种生成 caller。
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"


# assist：「AI 帮我配置」的对话调用，只进用量，不进创作台与画布。
Namespace = Literal["studio", "canvas", "assist"]
# 失败分类码：job_runner 写 error 时按 HTTP 状态、异常类型与报文关键词同时写；界面按码选文案与修复动作
# （web/src/lib/errorPresentation.ts）。service_unavailable 只给前端连接层用，runner 不写。
# submission_unconfirmed：提交请求可能已到上游、结局不明（`SubmissionUnconfirmed`），可能已计费，不按普通超时处理。
JobErrorCode = Literal[
    "insufficient_balance", "invalid_key", "model_unavailable", "content_rejected",
    "timeout", "submission_unconfirmed", "network", "bad_endpoint", "service_unavailable",
    "unknown",
]
ProviderTaskId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=512),
]


class MusicTrack(BaseModel):
    """音乐生成一首的厂商回报：歌名与歌词，顺序与 output_paths 一致。"""

    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="", max_length=200)
    lyric: str = Field(default="", max_length=10000)


class LayerDecompositionBoundingBox(BaseModel):
    """One layer's placement in the reconstructed Seedream canvas."""

    model_config = ConfigDict(extra="forbid")
    absolute: tuple[int, int, int, int]
    normalized: tuple[int, int, int, int]

    @model_validator(mode="after")
    def validate_bounds(self) -> "LayerDecompositionBoundingBox":
        left, top, right, bottom = self.absolute
        n_left, n_top, n_right, n_bottom = self.normalized
        if min(self.absolute) < 0 or left >= right or top >= bottom:
            raise ValueError("layer absolute bounding box is invalid")
        if (
            min(self.normalized) < 0
            or max(self.normalized) > 1000
            or n_left >= n_right
            or n_top >= n_bottom
        ):
            raise ValueError("layer normalized bounding box is invalid")
        return self


# Seedream 5.5 单次最多 1 张底图 + 99 个图层（5.0 Pro / Flash 为 1 + 16）。
LAYER_DECOMPOSITION_MAX_OUTPUTS = 100


class LayerDecompositionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    output_index: int = Field(ge=0, le=LAYER_DECOMPOSITION_MAX_OUTPUTS - 1)
    z_index: int = Field(ge=0, le=LAYER_DECOMPOSITION_MAX_OUTPUTS - 1)
    size: str = Field(min_length=1, max_length=40)
    output_format: Literal["png", "jpeg"]
    name: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=2000)
    bounding_box: LayerDecompositionBoundingBox | None = None

    @model_validator(mode="after")
    def require_layer_bounds(self) -> "LayerDecompositionOutput":
        if self.z_index > 0 and self.bounding_box is None:
            raise ValueError("decomposed foreground layer requires a bounding box")
        return self


class LayerDecompositionUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input_images: int | None = Field(default=None, ge=0)
    generated_images: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class LayerDecompositionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outputs: list[LayerDecompositionOutput] = Field(
        min_length=2, max_length=LAYER_DECOMPOSITION_MAX_OUTPUTS,
    )
    usage: LayerDecompositionUsage | None = None

    @model_validator(mode="after")
    def validate_outputs(self) -> "LayerDecompositionResult":
        indices = [item.output_index for item in self.outputs]
        z_indices = [item.z_index for item in self.outputs]
        if indices != list(range(len(indices))):
            raise ValueError("layer decomposition output indexes must be contiguous")
        if z_indices != sorted(z_indices) or z_indices.count(0) != 1:
            raise ValueError("layer decomposition outputs require one base followed by ordered layers")
        if len(z_indices) != len(set(z_indices)):
            raise ValueError("layer decomposition z indexes must be unique")
        return self


# JobParams 里登记本机文件路径的声明字段，按生成快照 inputs 的顺序排。/api/raw 的 job 读取白名单、
# 浏览器参考路径闸门、生成快照三处共用这一份，新增路径字段只改这里；各调用点的差异
# （mask_image 只由服务端写、extra 字段 source_image）在调用点显式加减。
# 只是 Python 常量，不是模型字段，TS 端无对应。
CanvasMjReferenceRole = Literal["mj_sref", "mj_cref", "mj_oref"]
MJ_REFERENCE_ROLES = ("mj_sref", "mj_cref", "mj_oref")


JOB_PARAM_PATH_FIELDS: tuple[str, ...] = (
    "reference_images", "reference_videos", "reference_audios", "mask_image", "markup_image",
    *MJ_REFERENCE_ROLES,
)


class VideoSubmissionAttempt(BaseModel):
    """Safe submission diagnostics; no request body or authorization headers."""

    attempt: int = Field(ge=1, le=4)
    method: Literal["POST"] = "POST"
    url: str
    started_at: str
    outcome: Literal["submitting", "response", "unconfirmed"]
    elapsed_ms: int | None = None
    http_status: int | None = None
    error_type: str | None = None
    request_ids: dict[str, str] = Field(default_factory=dict)
    # 连接都没建立、请求确定没发出（outcome 保持 submitting）。可选字段：旧版读到会忽略，不动 outcome 枚举。
    not_sent: bool | None = None


class EditInput(BaseModel):
    """图片编辑实际发给厂商的一张图；路径只由服务端写。"""
    model_config = ConfigDict(extra="forbid")
    role: Literal["source", "mask", "guide", "reference"]
    path: str


class SubjectSnapshot(BaseModel):
    id: str
    name: str
    revision: int
    item_ids: list[str]


class JobParams(BaseModel):
    model_config = ConfigDict(extra="allow")
    workflow_inputs: dict[str, str | int | float | bool | None] | None = None
    size: str | None = None
    size_mode: Literal["auto", "ratio", "custom"] | None = None
    custom_size: str | None = Field(default=None, max_length=40)
    steps: int | None = None
    cfg_scale: float | None = None
    # 出图卡片展示用 —— 让画师在确认前看到完整调用细节
    vendor: str | None = None
    n: int | None = None
    subjects: list[SubjectSnapshot] | None = Field(default=None, exclude_if=lambda value: value is None)
    subject_prompt: str | None = Field(default=None, exclude_if=lambda value: value is None)
    # Studio 提交时冻结的可核实人民币总价；无法计算时不写。
    estimated_cost_cny: float | None = Field(default=None, ge=0)
    # 厂商成功响应返回的实际人民币费用；历史展示优先于预计快照。
    actual_cost_cny: float | None = Field(default=None, ge=0)
    # 按字符计费的语音：上游回报的计费字符数。预计按朗读文本字数估；上游若按别的口径计
    # （例如一个汉字算两个字符），两者在记录里并排可见，不在估价里静默取一个。
    billed_characters: int | None = Field(default=None, ge=0)
    # 从创作资产复制提示词时冻结的只读来源名称，正文与变量值已经展开进 prompt。
    creation_asset_source_title: str | None = Field(default=None, max_length=120)
    reference_images: list[str] | None = None
    # Canvas 局部编辑专用：服务端从不可变 mask Content Version 解析，浏览器不能传路径。
    mask_image: str | None = None
    # GPT Image 2.6 标注层（官方 edits 的 `markup`）：与首张参考图同尺寸的透明 PNG，由服务端从画布
    # 标注的 markup Content Version 解析，浏览器不能传路径；与 mask_image 互斥。
    markup_image: str | None = None
    image_edit: dict[str, Any] | None = None
    mj_submission_ids: list[str] | None = None
    mj_submit_uncertain: bool | None = None
    # EvoLink 的提交边界、原订单与下载进度；仅 runner 可写，不能复用到新订单。
    evolink_state: dict[str, Any] | None = None
    comfyui_resume: dict[str, str] | None = None
    # Canvas 多角度生成专用：结构化相机参数进入 Snapshot，caller 只消费最终 prompt。
    angle_horizontal: int | None = Field(default=None, ge=-60, le=60)
    angle_pitch: int | None = Field(default=None, ge=-45, le=45)
    angle_distance: float | None = Field(default=None, ge=1, le=10)
    angle_wide: bool | None = None
    requested_size: str | None = None
    actual_size: str | None = None
    # 图片编辑实际发给厂商的图片与完整提示词，结果节点据此展示过程。
    edit_inputs: list[EditInput] | None = None
    edit_prompt: str | None = None
    warnings: list[str] | None = None
    # 选「自动」提交时的路由 id；有它才允许在确定没执行的失败上换下一家（见 model_routes）。
    route_id: str | None = Field(default=None, max_length=200)
    # 本次已经试过、因确定没执行的失败被换掉的供应商别名，按顺序。
    route_tried: list[str] | None = None
    # 提交时冻结的供应商顺序；失败切换不受后续路由设置与其它任务影响。
    route_order: list[str] | None = None
    # 厂商订单首次获取立即落盘。Tuzi 支持续查；Seedance 留供核对，不自动恢复或重提。
    # tuzi_async is a historical ownership tag, never a supported submission protocol.
    # 局域网 Atelier：网关那边实际出图的成员别名（ADR-0025）。
    gateway_member: str | None = Field(default=None, max_length=120)
    # 局域网 Atelier（接入端，runner 独占写）：第一次提交前生成并落盘的幂等键，以及这次实际发给
    # 主机的请求指纹（提示词、模型、参数、素材字节）。同一幂等键重发只会拿回主机上的原任务。
    gateway_idempotency_key: str | None = Field(default=None, max_length=200)
    gateway_request_fingerprint: str | None = Field(default=None, max_length=64)
    # 接入端没从主机拿到这次任务的终态（提交未确认、查询失败、下载失败）；「再次生成」据此接回原任务。
    gateway_unconfirmed: bool | None = None
    # 这次是「再次生成」接回的哪个失败任务；主机报原任务失败时在同一次运行里换新键重新下单。
    gateway_reattach_of: str | None = Field(default=None, max_length=200)
    # 用户停止了、停止请求还没送到主机（网关连不上）；由 gateway_cancel_outbox 恢复连接后按幂等键补发，
    # 主机答复后清掉。
    gateway_cancel_pending: bool | None = None
    # 停止已送到主机、主机答「已发上游、会跑完」：等主机终态回写扣费（gateway_cancel_outbox）。pending 等待中，settled 已结算。
    gateway_settlement: Literal["pending", "settled"] | None = None
    # 同一把幂等键的主机扣费只记一次（谁先拿到主机终态谁记，gateway_charges）：这条没记，金额记在这个任务上。
    gateway_charged_on: str | None = Field(default=None, max_length=200)
    provider_task_protocol: Literal[
        "tuzi_async", "tuzi_images", "seedance", "evolink", "atelier_gateway", "declarative",
        "yinchao",
    ] | None = None
    provider_task_ids: list[ProviderTaskId] | None = Field(default=None, max_length=4)
    video_submission_attempts: list[VideoSubmissionAttempt] | None = Field(default=None, max_length=4)
    # 图片参数 —— 前端实际在发（Studio 提交链路），显式声明保证双端类型对齐
    ratio: str | None = None               # e.g. "16:9"
    quality: str | None = None             # low | medium | high | xhigh | max | auto
    background: Literal["auto", "opaque", "transparent"] | None = None
    # GPT Image 2.6：规划强度（与 quality 独立）与 GIF 输出；caller 只对支持的模型发。
    complexity: Literal["low", "medium", "high"] | None = None
    output_format: Literal["gif"] | None = None
    frame_count: int | None = Field(default=None, ge=2, le=64)
    frame_duration_ms: int | None = Field(default=None, ge=20, le=2000)
    # Seedream 5.0 Pro / Flash 图层拆分：caller 回写有序图层元数据，output_index 对齐 Job.output_paths。
    layer_decomposition: bool | None = None
    # Seedream 5.5 图层拆分的最多输出张数（含底图）；不填由厂商默认 30。
    layer_max_images: int | None = Field(default=None, ge=2, le=LAYER_DECOMPOSITION_MAX_OUTPUTS)
    layer_decomposition_result: LayerDecompositionResult | None = None
    # 视频参数（kind=video）—— 做成一等公民以保证双端类型对齐
    seed: int | None = None
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
    # 音乐生成参数：自定义歌词（不填由模型作词）、纯音乐；music_tracks 是厂商返回的每首歌名与歌词。
    lyrics: str | None = Field(default=None, max_length=5000)
    instrumental: bool | None = None
    music_tracks: list[MusicTrack] | None = Field(default=None, max_length=4)
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
    collab_guest_name: str | None = Field(default=None, max_length=120, exclude_if=lambda v: v is None)
    collab_guest_client: str | None = Field(default=None, max_length=120, exclude_if=lambda v: v is None)
    collab_borrow_channel: str | None = Field(default=None, pattern="^[a-f0-9]{32}$", exclude_if=lambda v: v is None)
    collab_source_canvas: str | None = Field(default=None, max_length=160, exclude_if=lambda v: v is None)
    mj_seed: int | None = None        # --seed
    mj_no: str | None = None          # --no 排除词，逗号分隔
    mj_tile: bool | None = None       # --tile 无缝平铺
    mj_style_raw: bool | None = None  # --style raw 原始风格
    mj_iw: float | None = None        # --iw 垫图权重 0-3
    mj_sref_code: str | None = Field(default=None, pattern=r"^[0-9]+$", max_length=32)
    mj_profile: str | None = Field(default=None, pattern=r"^[A-Za-z0-9]+$", max_length=64)
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

    @model_validator(mode="before")
    @classmethod
    def drop_retired_prompt_preview_target(cls, value):
        if isinstance(value, dict) and "prompt_asset_id" in value:
            return {key: item for key, item in value.items() if key != "prompt_asset_id"}
        return value


class CanvasActor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["user", "agent", "plugin"]
    actor_id: str | None = None


class CanvasSnapshotInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    annotated: bool = False
    order: int = Field(ge=0)
    source: Literal[
        "implicit_self", "explicit_source", "input_connection",
        # 由分组展开而来的成员：与直连素材一样参与编号和能力校验，但超出模型参考图上限时
        # 先从它们里截断（整包是顺手连上的，逐条直连是画师一笔一笔连的，优先保留后者）。
        "group_member", "mj_sref", "mj_cref", "mj_oref",
        "first_frame", "last_frame",
    ]
    node_id: str
    version_id: str
    kind: Literal["text", "image", "video", "audio"]
    # 带标注输入按 markup 发送时：version_id 是原图，这里记标注层版本（透明 PNG）。
    markup_version_id: str | None = None


class CanvasTextRevision(BaseModel):
    """「改写」任务：以节点当前正文为输入，结果写回同一节点。

    选区按 Unicode 码点计（浏览器端从 UTF-16 下标换算）；start/end 都为空 = 改全文。
    """
    model_config = ConfigDict(extra="forbid")
    base_version_id: str
    instruction: str = Field(min_length=1, max_length=2000)
    selection_start: int | None = Field(default=None, ge=0)
    selection_end: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _selection_pair(self):
        start, end = self.selection_start, self.selection_end
        if (start is None) != (end is None):
            raise ValueError("选区起止必须同时给出")
        if start is not None and end is not None and start >= end:
            raise ValueError("选区不能为空")
        return self


class CanvasGenerationSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    snapshot_version: Literal[1] = 1
    surface_node_id: str
    result_node_id: str
    mode: Literal["text", "image", "video", "audio"]
    final_prompt: str
    draft_prompt: str | None = None
    input_policy: Literal["all_connected", "mentions_only"]
    model: str
    provider: str
    alias: str | None = None
    normalized_params: dict[str, Any]
    inputs: list[CanvasSnapshotInput]
    mask_version_id: str | None = None
    submitted_at: str
    submitted_by: CanvasActor
    text_revision: CanvasTextRevision | None = Field(default=None, exclude_if=lambda v: v is None)
    request_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


class CanvasResultCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_id: str
    index: int = Field(ge=0)
    status: Literal["pending", "succeeded", "failed", "canceled"]
    version_id: str | None = None
    error: str | None = None
    actual_cost_cny: float | None = Field(default=None, ge=0, exclude_if=lambda v: v is None)
    estimated_cost_cny: float | None = Field(default=None, ge=0, exclude_if=lambda v: v is None)
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
    # 2026-11-25: 与 error 同时写、同时清；None 时不落盘（旧任务文件不变）。Web 不能改。
    error_code: JobErrorCode | None = None
    kind: JobKind = JobKind.IMAGE
    namespace: Namespace = "studio"
    source_image: str | None = None  # 参考素材的绝对路径
    studio_agent_session_id: str | None = Field(
        default=None, pattern=r"^session-[a-z0-9-]{8,64}$",
    )
    studio_agent_turn_id: str | None = Field(
        default=None, pattern=r"^turn-[a-z0-9-]{1,64}$",
    )
    # Canvas 生成任务归属项目与运行快照。
    canvas_project_id: str | None = None
    canvas_run: CanvasJobContext | None = None
    # Phase 3 (2026-05-22): which Key was used. Web 不能改这两个字段。
    alias: str | None = None
    provider: str | None = None
    # 2026-06-10: retry-job 克隆 failed job 时指回原 job_id；原 job 错误记录保留。
    retry_of: str | None = None
    # 2026-06-12: 出图进度真实卡点（视频 caller 经 job_runner 回写；Web 不能改）。
    # sent=任务已全部提交上游；downloading=任务成功、产物下载中。终态时清空。
    # waiting_gateway：局域网 Atelier 暂时连不上，接入端在等它恢复（第 2 批 B2）。
    progress_phase: str | None = Field(
        default=None, pattern=r"^(sent|downloading|waiting_gateway|queued:[1-9][0-9]*)$")
    # 2026-07-08: 出图完成时间戳（update_job_status 在 DONE/FAILED 终态回写；Web 不能改）。
    # Studio 卡片用它算出图耗时（completed_at − submitted_at）+ 展示生成时间。旧 job 无此字段=None。
    completed_at: str | None = None
    # Canvas Run only: the runner claims a queued Job before the provider call.
    runner_started_at: str | None = None
    # Any namespace: a stop request stays truthful even when a synchronous upstream request cannot
    # be interrupted; the runner turns it into CANCELED at the next cancellation point.
    cancel_requested_at: str | None = None

    @model_serializer(mode="wrap")
    def _omit_empty_optional_fields(self, handler):
        data = handler(self)
        if self.studio_agent_session_id is None:
            data.pop("studio_agent_session_id", None)
        if self.studio_agent_turn_id is None:
            data.pop("studio_agent_turn_id", None)
        # 分类码只跟着失败原因出现：model_copy 清掉 error 时不跑校验，这里兜住残留。
        if self.error_code is None or self.error is None:
            data.pop("error_code", None)
        return data

    @model_validator(mode="before")
    @classmethod
    def retire_batch_origin(cls, value: object) -> object:
        # 批量素材与批量执行已删除，旧 job 的 `canvas_run.batch` 读时剥掉。批次确认不授权重启后提交
        # 还没开始的步骤：这类 job 标记为已请求取消，由 reconcile 走现有取消路径，不会被重新提交。
        run = value.get("canvas_run") if isinstance(value, dict) else None
        if not isinstance(run, dict) or "batch" not in run:
            return value
        updated = {**value, "canvas_run": {key: item for key, item in run.items() if key != "batch"}}
        if (run.get("batch") is not None and value.get("status") in {"pending", "pending_confirm"}
                and value.get("runner_started_at") is None and not value.get("cancel_requested_at")):
            updated["cancel_requested_at"] = value.get("submitted_at")
        return updated

    @model_validator(mode="after")
    def validate_namespace_ownership(self) -> "Job":
        if self.namespace == "canvas":
            if not self.canvas_project_id or self.canvas_run is None:
                raise ValueError("canvas job requires canvas_project_id and canvas_run")
        elif self.canvas_project_id is not None or self.canvas_run is not None:
            raise ValueError("canvas_project_id and canvas_run are only valid for namespace=canvas")
        if self.studio_agent_session_id is not None and self.namespace != "studio":
            raise ValueError("studio_agent_session_id requires a studio job")
        if self.studio_agent_turn_id is not None and self.studio_agent_session_id is None:
            raise ValueError("studio_agent_turn_id requires a studio agent session")
        if self.namespace != "canvas" and self.runner_started_at is not None:
            raise ValueError("runner_started_at is only valid for namespace=canvas")
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


class CanvasGroupSize(BaseModel):
    """A derived member bounding box, not a resizable media surface."""
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class CanvasViewport(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float = 0
    y: float = 0
    zoom: float = Field(default=1, gt=0.05, le=5)


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
    "removeBackground",
    "angle",
]


class CanvasImageToolbarPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    tool_ids: list[CanvasImageQuickToolId]

    @model_validator(mode="after")
    def unique_tools(self) -> "CanvasImageToolbarPreferences":
        if len(self.tool_ids) != len(set(self.tool_ids)):
            raise ValueError("图片快捷工具不能重复")
        return self


class CanvasGenerationModelSelection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    # None =「自动」：model 是路由 id，提交时按组内顺序解析 KEY（见 model_routes）。
    alias: str | None = Field(default=None, min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=200)


CanvasSafeOption = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=32,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:+-]*$",
    ),
]


class CanvasTextDefaultParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    n: int | None = Field(default=None, ge=1, le=4)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=1_000_000)
    reasoning_effort: Literal["auto", "low", "medium", "high", "xhigh"] | None = None


class CanvasImageDefaultParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    n: int | None = Field(default=None, ge=1, le=4)
    ratio: CanvasSafeOption | None = None
    resolution: CanvasSafeOption | None = None
    size: str | None = Field(default=None, max_length=40, pattern=r"^[A-Za-z0-9_.:+-]*$")
    size_mode: Literal["auto", "ratio", "custom"] | None = None
    custom_size: str | None = Field(default=None, max_length=40, pattern=r"^[A-Za-z0-9_.:+-]*$")
    quality: Literal["low", "medium", "high", "xhigh", "max", "auto"] | None = None
    complexity: Literal["low", "medium", "high"] | None = None


class CanvasVideoDefaultParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    duration: int | None = Field(default=None, ge=1, le=60)
    ratio: CanvasSafeOption | None = None
    resolution: CanvasSafeOption | None = None
    frame_mode: Literal["auto", "firstlast"] | None = None
    mode: Literal["std", "pro"] | None = None
    generate_audio: bool | None = None
    watermark: bool | None = None


class CanvasAudioDefaultParams(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    # 音色随模型协议变化（见 data/audio_caps.json），MiniMax 还接受自定义音色 ID；提交时再按协议归一。
    voice: str | None = Field(default=None, min_length=1, max_length=200)
    response_format: Literal["mp3", "wav", "opus", "aac", "flac", "pcm"] | None = None
    speed: float | None = Field(default=None, ge=0.25, le=4)
    instructions: str | None = Field(default=None, max_length=4096)


class CanvasMusicDefaultParams(BaseModel):
    """音乐偏好只记纯音乐开关；歌词与首数是每次的决定。"""

    model_config = ConfigDict(extra="forbid", strict=True)
    instrumental: bool | None = None


def _validated_canvas_default_params(value: object, schema: type[BaseModel]) -> dict[str, JsonValue]:
    return schema.model_validate(value).model_dump(mode="json", exclude_none=True)


class CanvasTextGenerationDefault(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    selection: CanvasGenerationModelSelection | None = None
    params: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("params")
    @classmethod
    def valid_params(cls, value: object) -> dict[str, JsonValue]:
        return _validated_canvas_default_params(value, CanvasTextDefaultParams)


class CanvasImageGenerationDefault(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    selection: CanvasGenerationModelSelection | None = None
    params: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("params")
    @classmethod
    def valid_params(cls, value: object) -> dict[str, JsonValue]:
        return _validated_canvas_default_params(value, CanvasImageDefaultParams)


class CanvasVideoGenerationDefault(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    selection: CanvasGenerationModelSelection | None = None
    params: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("params")
    @classmethod
    def valid_params(cls, value: object) -> dict[str, JsonValue]:
        return _validated_canvas_default_params(value, CanvasVideoDefaultParams)


class CanvasAudioGenerationDefault(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    selection: CanvasGenerationModelSelection | None = None
    params: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("params")
    @classmethod
    def valid_params(cls, value: object) -> dict[str, JsonValue]:
        return _validated_canvas_default_params(value, CanvasAudioDefaultParams)


class CanvasMusicGenerationDefault(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    selection: CanvasGenerationModelSelection | None = None
    params: dict[str, JsonValue] = Field(default_factory=dict)

    @field_validator("params")
    @classmethod
    def valid_params(cls, value: object) -> dict[str, JsonValue]:
        return _validated_canvas_default_params(value, CanvasMusicDefaultParams)


class CanvasGenerationDefaults(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: CanvasTextGenerationDefault = Field(default_factory=CanvasTextGenerationDefault)
    image: CanvasImageGenerationDefault = Field(default_factory=CanvasImageGenerationDefault)
    video: CanvasVideoGenerationDefault = Field(default_factory=CanvasVideoGenerationDefault)
    # audio 是语音的偏好；音乐节点同属 audio 生成模式，偏好单独存一份。
    audio: CanvasAudioGenerationDefault = Field(default_factory=CanvasAudioGenerationDefault)
    music: CanvasMusicGenerationDefault = Field(default_factory=CanvasMusicGenerationDefault)


# 源自画师资产库「通用高清-真实-Banana Pro」，去掉写实限定，卡通 / 矢量素材同样适用。
CANVAS_UPSCALE_DEFAULT_PROMPT = (
    "分析画面构图、光影、对比度、色彩饱和度与纯度。保持原有构图，保持原有背景不变，"
    "保持与原图光影一致，无缝集成，完美融合，以原图风格为基础进行操作："
    "不能缩放旋转画面，保持原有材质，保持明度不变，保持画面色相饱和度不变，"
    "保持画面伽马值与对比度不变。按照以上指令基准守则进行以下操作："
    "使图片变清晰，添加细节纹理，高清，4K，8K，超清画质，更精致的画质表现。"
    "masterpiece, best quality, highres:1.2"
)


CanvasUpscaleTarget = Literal["2K", "4K", "8K"]
CANVAS_UPSCALE_TARGETS: tuple[CanvasUpscaleTarget, ...] = ("2K", "4K", "8K")
CANVAS_UPSCALE_LONG_EDGES: dict[str, int] = {"2K": 2048, "4K": 4096, "8K": 8192}


class CanvasUpscaleTierPreferences(BaseModel):
    """一个档位的 AI高清配置：模型、提示词、质量。

    selection 为 None 时服务端自动选模（只有 2K / 4K 有 Nano Banana 自动路线）。
    分辨率按模型族取：暴露 quality 的模型用 quality，按像素出图的模型直接用档位长边。
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    selection: CanvasGenerationModelSelection | None = None
    quality: Literal["low", "medium", "high", "xhigh", "max", "auto"] | None = None
    prompt: str = Field(default=CANVAS_UPSCALE_DEFAULT_PROMPT, max_length=4000)

    @field_validator("prompt")
    @classmethod
    def default_when_blank(cls, value: str) -> str:
        # 清空即恢复内置提示词，前端不必再持有第二份默认文案。
        return value.strip() or CANVAS_UPSCALE_DEFAULT_PROMPT


def _default_upscale_tiers() -> dict[CanvasUpscaleTarget, CanvasUpscaleTierPreferences]:
    return {target: CanvasUpscaleTierPreferences() for target in CANVAS_UPSCALE_TARGETS}


class CanvasUpscalePreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    tiers: dict[CanvasUpscaleTarget, CanvasUpscaleTierPreferences] = Field(
        default_factory=_default_upscale_tiers,
    )

    @model_validator(mode="before")
    @classmethod
    def lift_single_model_shape(cls, value: object) -> object:
        # 5.51.0 只存一个模型 + 一段提示词（`{selection, prompt}`），当时的 2K / 4K 都用它。
        if isinstance(value, dict) and "tiers" not in value and {"selection", "prompt"} & set(value):
            tier = {name: value[name] for name in ("selection", "prompt") if name in value}
            return {"tiers": {target: dict(tier) for target in ("2K", "4K")}}
        return value

    @field_validator("tiers")
    @classmethod
    def every_tier_present(
        cls, value: dict[CanvasUpscaleTarget, CanvasUpscaleTierPreferences],
    ) -> dict[CanvasUpscaleTarget, CanvasUpscaleTierPreferences]:
        return {
            target: value.get(target) or CanvasUpscaleTierPreferences()
            for target in CANVAS_UPSCALE_TARGETS
        }


class CanvasUiPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal[2] = 2
    revision: int = Field(default=0, ge=0)
    image_toolbar: CanvasImageToolbarPreferences
    generation_defaults: CanvasGenerationDefaults
    upscale: CanvasUpscalePreferences = Field(default_factory=CanvasUpscalePreferences)
    updated_at: datetime | None = None


class CanvasUiPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: int = Field(ge=0)
    image_toolbar: CanvasImageToolbarPreferences
    generation_defaults: CanvasGenerationDefaults
    upscale: CanvasUpscalePreferences = Field(default_factory=CanvasUpscalePreferences)


# 主题色：内置主题的 id 与名称和 web/src/lib/accentPresets.ts 一致（tests/test_accent_themes.py 对照）。
BUILTIN_ACCENT_THEMES: dict[str, str] = {
    "lime": "青柠", "violet": "电光紫", "orange": "信号橙", "cyan": "冰川青",
    "pink": "珊瑚粉", "yellow": "柠檬黄", "blue": "钴蓝",
}
ACCENT_THEME_NAME_MAX = 12
ACCENT_USER_THEME_MAX = 24
BuiltinAccentThemeId = Literal["lime", "violet", "orange", "cyan", "pink", "yellow", "blue"]
AccentHexColor = Annotated[str, StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$")]
AccentUserThemeId = Annotated[str, StringConstraints(pattern=r"^u-[a-z0-9]{8,32}$")]
AccentThemeName = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=1, max_length=ACCENT_THEME_NAME_MAX)]


class AccentColors(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    primary: AccentHexColor
    brand2: AccentHexColor
    brand3: AccentHexColor
    brand4: AccentHexColor


class AccentBuiltinOverride(AccentColors):
    """改过的内置主题：四色必填；name 只在改过名时出现。"""
    name: AccentThemeName | None = None


class AccentUserTheme(AccentColors):
    id: AccentUserThemeId
    name: AccentThemeName


class _AccentThemesBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    active: str = Field(default="lime", min_length=1, max_length=40)
    overrides: dict[BuiltinAccentThemeId, AccentBuiltinOverride] = Field(default_factory=dict)
    custom: list[AccentUserTheme] = Field(default_factory=list, max_length=ACCENT_USER_THEME_MAX)

    @model_validator(mode="after")
    def _consistent(self):
        ids = [theme.id for theme in self.custom]
        if len(set(ids)) != len(ids):
            raise ValueError("主题 id 重复")
        builtin_names = [
            (self.overrides[theme_id].name if theme_id in self.overrides else None) or default
            for theme_id, default in BUILTIN_ACCENT_THEMES.items()
        ]
        taken: set[str] = set()
        for name in [*builtin_names, *(theme.name for theme in self.custom)]:
            key = name.casefold()
            if key in taken:
                raise ValueError(f"已有名为「{name}」的主题")
            taken.add(key)
        if self.active not in BUILTIN_ACCENT_THEMES and self.active not in ids:
            raise ValueError("当前主题不存在")
        return self


class AccentThemes(_AccentThemesBody):
    """`.config/accent-themes.json`：用户主题、对内置主题的改色与当前选中项。revision 0 = 从未保存。"""
    schema_version: Literal[1] = 1
    revision: int = Field(default=0, ge=0)
    updated_at: datetime | None = None


class AccentThemesUpdate(_AccentThemesBody):
    expected_revision: int = Field(ge=0)


class CanvasGenerationDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["text", "image", "video", "audio"]
    prompt: str = Field(default="", max_length=40_000)
    input_policy: Literal["all_connected"] = "all_connected"
    model: str = Field(default="", max_length=200)
    alias: str | None = Field(default=None, max_length=120)
    params: JobParams = Field(default_factory=JobParams)
    updated_at: str


# 浏览器可以通过 PUT /canvas/projects/{id}/document 自由写入每个 Draft 的 params，而 JobParams 是
# extra="allow"。所以冻结 Snapshot 时不能从全量 model_dump 起手做黑名单剔除：漏掉任何一个服务端
# 独占字段，浏览器就能把本地路径写进 job.params —— /api/raw 的读取白名单正是按 params 里的路径字段
# （mask_image / mj_sref / mj_cref / mj_oref）构造的，等于用一次正常出图换任意本地文件读取权，
# 而 mj_image caller 还会把本地路径上传成公网直链。
# 下面按 mode 列出「浏览器有权提交」的字段，其余一律丢弃。Canvas 的参考素材只能来自不可变
# Content Version，所以全部路径类字段都不在名单里；新增控件时必须同时把字段加进这里。
CANVAS_DRAFT_PARAM_FIELDS: dict[str, frozenset[str]] = {
    "image": frozenset({
        "workflow_inputs",
        "n", "size", "size_mode", "custom_size", "ratio", "resolution", "quality",
        "complexity", "output_format", "frame_count", "frame_duration_ms", "background",
        "creation_asset_source_title",
        # 多角度生成由服务端写进结果 Draft，浏览器会原样回传，必须放行。
        "angle_horizontal", "angle_pitch", "angle_distance", "angle_wide",
        # Midjourney 的纯标量 flag（都有 Field 上下界）；三组参考路径与 caller 回写的
        # mj_flags 不在其中。
        "mode", "bot_type", "mj_version", "mj_stylize", "mj_chaos", "mj_weird",
        "mj_profile", "mj_sref_code",
        "mj_seed", "mj_no", "mj_tile", "mj_style_raw", "mj_iw", "mj_sw", "mj_cw", "mj_ow",
    }),
    "video": frozenset({
        "duration", "resolution", "ratio", "mode", "frame_mode", "seed",
        "generate_audio", "watermark", "creation_asset_source_title",
    }),
    "text": frozenset({
        "n", "temperature", "max_tokens", "reasoning_effort",
        "creation_asset_source_title",
    }),
    "audio": frozenset({
        "voice", "response_format", "speed", "instructions", "lyrics", "instrumental", "n",
        "creation_asset_source_title",
    }),
}


def canvas_allowed_draft_params(mode: str, params: JobParams) -> dict[str, Any]:
    """Keep only the Draft params a browser is allowed to submit for this mode."""
    allowed = CANVAS_DRAFT_PARAM_FIELDS.get(mode, frozenset())
    return {
        field: value
        for field, value in params.model_dump(mode="json", exclude_none=True).items()
        if field in allowed
    }


class CanvasContentNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_version_id: str | None = None
    generation_draft: CanvasGenerationDraft | None = None
    active_run_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def drop_batch_result(cls, value: object) -> object:
        # 批量素材删除前，内容节点都带 `batch_result`（多数是 null）；已有画布和导出包里还留着这个键。
        if isinstance(value, dict) and "batch_result" in value:
            return {key: item for key, item in value.items() if key != "batch_result"}
        return value


class CanvasTextDisplay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scale: Literal["xs", "sm", "base"] = "sm"


class CanvasTextNodeData(CanvasContentNodeData):
    display: CanvasTextDisplay = Field(default_factory=CanvasTextDisplay)


class CanvasMediaDisplay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fit: Literal["contain", "cover"] = "contain"
    free_resize: bool = False


class CanvasResultStack(BaseModel):
    """一次生成出多张时的结果组：封面（本节点）+ 其余结果各自的图片节点。

    `run_id` 记录已经拆成节点的那次生成，避免成员被删后又按同一批结果长回来。
    成员 id 读的时候按存在过滤，不在文档级校验：删掉成员不能让整份画布读不出来。
    """

    model_config = ConfigDict(extra="forbid")
    run_id: str = Field(min_length=1, max_length=160)
    member_node_ids: list[str] = Field(default_factory=list, max_length=64)


class CanvasMediaNodeData(CanvasContentNodeData):
    display: CanvasMediaDisplay = Field(default_factory=CanvasMediaDisplay)
    annotation: CanvasImageAnnotation | None = None
    result_stack: CanvasResultStack | None = None


AnnotationColor = Literal["#F04438", "#FACC15", "#22C55E", "#3B82F6", "#FFFFFF"]
FinitePx = Annotated[float, Field(ge=-100_000, le=100_000, allow_inf_nan=False)]
AnnotationPoint = tuple[FinitePx, FinitePx]
ANNOTATION_UNIT_BASE = 1024


def annotation_unit_scale(width: float, height: float) -> float:
    return max(width, height) / ANNOTATION_UNIT_BASE


class _AnnotationElementBase(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=64)
    color: AnnotationColor


class AnnotationRect(_AnnotationElementBase):
    type: Literal["rect"]
    x: FinitePx
    y: FinitePx
    width: float = Field(ge=0, le=100_000)
    height: float = Field(ge=0, le=100_000)
    stroke_width: float = Field(ge=1, le=24)


class AnnotationArrow(_AnnotationElementBase):
    type: Literal["arrow"]
    start: AnnotationPoint
    end: AnnotationPoint
    stroke_width: float = Field(ge=1, le=24)


class AnnotationFreedraw(_AnnotationElementBase):
    type: Literal["freedraw"]
    points: list[AnnotationPoint] = Field(min_length=2, max_length=10_000)
    stroke_width: float = Field(ge=1, le=24)


class AnnotationText(_AnnotationElementBase):
    type: Literal["text"]
    x: FinitePx
    y: FinitePx
    text: str = Field(min_length=1, max_length=500)
    font_size: float = Field(ge=12, le=72)
    background: bool = False


AnnotationElement = Annotated[
    AnnotationRect | AnnotationArrow | AnnotationFreedraw | AnnotationText,
    Field(discriminator="type"),
]


class CanvasImageAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: str = Field(min_length=1, max_length=160)
    elements: list[AnnotationElement] = Field(default_factory=list, max_length=500)
    visible: bool = True
    rendered_version_id: str | None = Field(default=None, min_length=1, max_length=160)
    # 只含标注、背景透明的同尺寸 PNG；给 GPT Image 2.6 的 markup 字段用，与合成图各自独立失效。
    markup_version_id: str | None = Field(default=None, min_length=1, max_length=160)

    @model_validator(mode="after")
    def validate_scene(self) -> "CanvasImageAnnotation":
        elements = [element.model_dump(mode="json") for element in self.elements]
        if len(json.dumps(elements, ensure_ascii=False).encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("annotation exceeds 2 MiB")
        return self


class CanvasImageEditSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    mode: Literal["inpaint", "outpaint"] = "inpaint"
    width: int | None = Field(default=None, ge=1, le=16384)
    height: int | None = Field(default=None, ge=1, le=16384)
    x: int = Field(default=0, ge=0, le=16384)
    y: int = Field(default=0, ge=0, le=16384)


# Source decoding accepts up to 64M pixels, so a legal one-pixel-high source can
# have this many pixels on one axis. Editor metadata is not an execution canvas.
_CANVAS_EDITOR_MAX_AXIS = 64_000_000


class CanvasImageEditPoint(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float = Field(ge=-_CANVAS_EDITOR_MAX_AXIS, le=2 * _CANVAS_EDITOR_MAX_AXIS)
    y: float = Field(ge=-_CANVAS_EDITOR_MAX_AXIS, le=2 * _CANVAS_EDITOR_MAX_AXIS)


class CanvasImageEditStroke(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    tool: Literal["brush", "eraser", "rectangle"]
    size: float = Field(gt=0, le=_CANVAS_EDITOR_MAX_AXIS)
    points: list[CanvasImageEditPoint] = Field(default_factory=list, max_length=10000)


class CanvasImageEditFrame(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    width: int = Field(default=1, ge=1, le=_CANVAS_EDITOR_MAX_AXIS)
    height: int = Field(default=1, ge=1, le=_CANVAS_EDITOR_MAX_AXIS)
    x: int = Field(default=0, ge=0, le=_CANVAS_EDITOR_MAX_AXIS)
    y: int = Field(default=0, ge=0, le=_CANVAS_EDITOR_MAX_AXIS)


class CanvasImageEditEditorState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    strokes: list[CanvasImageEditStroke] = Field(default_factory=list, max_length=1000)
    frame: CanvasImageEditFrame = Field(default_factory=CanvasImageEditFrame)
    frame_ratio: str = Field(default="original", max_length=40)

    @model_validator(mode="after")
    def bounded_points(self):
        if sum(len(stroke.points) for stroke in self.strokes) > 100000:
            raise ValueError("编辑笔迹超过 100000 个点")
        return self


class CanvasImageEditNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_node_id: str | None = Field(default=None, max_length=120)
    source_version_id: str = Field(min_length=1, max_length=160)
    mask_version_id: str | None = Field(default=None, max_length=160)
    reference_node_id: str | None = Field(default=None, max_length=120)
    reference_version_id: str | None = Field(default=None, max_length=160)
    generation_draft: CanvasGenerationDraft | None = None
    options: CanvasImageEditSettings = Field(default_factory=CanvasImageEditSettings)
    editor_state: CanvasImageEditEditorState = Field(default_factory=CanvasImageEditEditorState)
    active_run_id: str | None = Field(default=None, max_length=160)

    @model_validator(mode="after")
    def image_draft_only(self):
        if self.generation_draft is not None and self.generation_draft.mode != "image":
            raise ValueError("image edit node requires an image generation draft")
        return self


class CanvasGroupNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_node_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def drop_repeat_count(cls, value: object) -> object:
        # 5.85.0 删除「执行分组」前，分组带着 `repeat_count`；已有画布和导出包里还留着这个键。
        if isinstance(value, dict) and "repeat_count" in value:
            return {key: item for key, item in value.items() if key != "repeat_count"}
        return value


class CanvasLayerStackLayer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=120)
    version_id: str = Field(min_length=1, max_length=160)
    z_index: int = Field(ge=0, le=LAYER_DECOMPOSITION_MAX_OUTPUTS - 1)
    name: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=2000)
    bounding_box: LayerDecompositionBoundingBox
    visible: bool = True
    material_node_id: str | None = None


class CanvasLayerStackData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_version_id: str = Field(min_length=1, max_length=160)
    alias: str | None = Field(default=None, min_length=1, max_length=120)
    model: str | None = Field(default=None, min_length=1, max_length=240)
    prompt: str = Field(default="", max_length=4000)
    resolution: Literal["auto", "1K", "1.5K", "2K"] = "auto"
    # 最多输出张数（含底图），只有 Seedream 5.5 支持；None = 厂商默认 30。
    max_images: int | None = Field(default=None, ge=2, le=LAYER_DECOMPOSITION_MAX_OUTPUTS)
    base_version_id: str | None = Field(default=None, max_length=160)
    base_z_index: int = Field(default=0, ge=0, le=LAYER_DECOMPOSITION_MAX_OUTPUTS - 1)
    base_visible: bool = True
    base_material_node_id: str | None = None
    layout_size: CanvasGroupSize | None = None
    layers: list[CanvasLayerStackLayer] = Field(
        default_factory=list, max_length=LAYER_DECOMPOSITION_MAX_OUTPUTS - 1,
    )
    active_run_id: str | None = Field(default=None, max_length=160)
    error: str | None = Field(default=None, max_length=4000)


class CanvasPluginNodeData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plugin_id: str = Field(min_length=1, max_length=120)
    node_type: str = Field(min_length=1, max_length=120)
    plugin_version: str = Field(min_length=1, max_length=80)
    # 创建节点时的包摘要，占位信息与将来的版本 pin 用。可选：早于它的文档必须照常读得出。
    package_digest: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    data_schema_version: int = Field(ge=1)
    payload: JsonValue
    shared_placeholder: bool = Field(default=False, exclude_if=lambda value: not value)
    generation_draft: CanvasGenerationDraft | None = None

    @model_validator(mode="after")
    def validate_payload_size(self) -> "CanvasPluginNodeData":
        encoded = json.dumps(
            self.payload, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        if len(encoded) > 256 * 1024:
            raise ValueError("canvas plugin payload exceeds 256 KiB")
        return self


class CanvasCompareNodeData(BaseModel):
    """对比的两张图由 before / after 两条输入连线决定，节点自身不存内容。"""

    model_config = ConfigDict(extra="forbid")


class CanvasNodeBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    created_by: str | None = Field(default=None, max_length=120, exclude_if=lambda v: v is None)
    created_by_client: str | None = Field(default=None, max_length=120, exclude_if=lambda v: v is None)
    collab_run: CanvasCollabRun | None = Field(default=None, exclude_if=lambda v: v is None)
    id: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=120)
    position: CanvasPoint
    size: CanvasSize | None = None
    z_index: int = Field(default=0, ge=-10_000, le=10_000)
    # 内容打码：只影响显示，连线 / 导出 / 参考照常。随文档保存。
    hidden: bool = False


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


class CanvasGroupNode(CanvasNodeBase):
    type: Literal["group"]
    size: CanvasGroupSize | None = None
    data: CanvasGroupNodeData


class CanvasLayerStackNode(CanvasNodeBase):
    type: Literal["layer_stack"]
    data: CanvasLayerStackData


class CanvasImageEditNode(CanvasNodeBase):
    type: Literal["image_edit"]
    data: CanvasImageEditNodeData


class CanvasPluginNode(CanvasNodeBase):
    type: Literal["plugin"]
    data: CanvasPluginNodeData


class CanvasCompareNode(CanvasNodeBase):
    type: Literal["compare"]
    data: CanvasCompareNodeData


CanvasNode = Annotated[
    CanvasTextNode | CanvasImageNode | CanvasVideoNode | CanvasAudioNode
    | CanvasGroupNode | CanvasPluginNode
    | CanvasLayerStackNode | CanvasImageEditNode | CanvasCompareNode,
    Field(discriminator="type"),
]


class CanvasInputConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=160)
    role: Literal["input"]
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    # first_frame / last_frame：视频首尾帧；before / after：对比节点的两侧。
    slot: Literal["first_frame", "last_frame", "before", "after"] | None = None
    mj_role: CanvasMjReferenceRole | None = None
    annotated: bool = False
    # 带标注连线发给模型的形式：缺省 = 目标模型与渠道支持时发「原图 + markup 标注层」，否则发合成图；
    # "composite" 固定发合成图。只在 annotated 连线上有意义。
    annotation_delivery: Literal["markup", "composite"] | None = None


class CanvasMaterialConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=160)
    role: Literal["material"]
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)


CanvasConnection = Annotated[
    CanvasInputConnection | CanvasMaterialConnection, Field(discriminator="role"),
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
    expanded_canvas: bool = False


class CanvasJobOutputOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["job_output"]
    job_id: str
    candidate_id: str


class CanvasLayerDecompositionOrigin(BaseModel):
    """A non-candidate image emitted as part of one layer-decomposition result."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["layer_decomposition"]
    job_id: str
    output_index: int = Field(ge=1, le=16)


class CanvasImportOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["import"]
    package_id: str


class CanvasCreationAssetSnapshotOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["creation_asset_snapshot"]
    title: str = Field(min_length=1, max_length=120)
    # 早期资产快照带有来源 ID，保留已有记录。
    asset_id: str | None = Field(default=None, min_length=1, max_length=160, exclude_if=lambda v: v is None)


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
    # 5.50.0 起放大改走 Nano Banana 生成 Run，浏览器不再能发起本地重采样；这个 origin 记录
    # 只为读取旧文档里已存在的「本地放大」版本保留。
    model_config = ConfigDict(extra="forbid")
    kind: Literal["upscale"]
    target_long_edge: int = Field(gt=0, le=4096)
    algorithm: Literal["nearest", "bilinear", "lanczos"]


class CanvasRemoveBackgroundOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["remove_background"]
    model: str = Field(min_length=1, max_length=80)


CanvasLocalToolOperation = Annotated[
    CanvasCropOperation | CanvasSplitOperation | CanvasUpscaleOperation
    | CanvasRemoveBackgroundOperation,
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
    | CanvasLayerDecompositionOrigin | CanvasLocalToolOrigin | CanvasImportOrigin
    | CanvasCreationAssetSnapshotOrigin,
    Field(discriminator="kind"),
]


class CanvasFrozenInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    role: Literal["reference", "mask", "markup", "first_frame", "last_frame", "source",
                  "mj_sref", "mj_cref", "mj_oref"]
    kind: Literal["image", "video", "audio", "text"]
    order: int = Field(ge=0)
    version_id: str | None = Field(default=None, min_length=1, max_length=160)
    text: str | None = Field(default=None, max_length=40_000)

    @model_validator(mode="after")
    def validate_content(self) -> "CanvasFrozenInput":
        if self.kind == "text":
            if self.text is None or self.version_id is not None:
                raise ValueError("frozen text inputs must contain inline text")
        elif self.version_id is None or self.text is not None:
            raise ValueError("frozen media inputs require a content version")
        return self


PublicGenerationParams = dict[str, str | int | float | bool | dict[str, str | int | float | bool | None]]


class CanvasFrozenGeneration(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    schema_version: Literal[1] = 1
    source_kind: Literal["canvas", "studio", "shared_canvas"]
    mode: Literal["image", "video", "audio", "text"]
    prompt: str = ""
    model_id: str
    model_name: str | None = None
    provider: str
    provider_label: str | None = None
    provider_icon: str | None = Field(default=None, pattern=r"^brand:[a-z0-9-]+$")
    params: PublicGenerationParams = Field(default_factory=dict)
    inputs: list[CanvasFrozenInput] = Field(default_factory=list)
    duration_s: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    cost_cny: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    created_by: str | None = None
    submitted_at: str | None = None

    @field_validator("params", mode="before")
    @classmethod
    def public_creation_params(cls, value):
        from character_workflow.lib.collab_sanitize import frozen_params
        return frozen_params(value)


class CanvasContentVersionBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: str = Field(min_length=1, max_length=160)
    created_at: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    origin: CanvasContentOrigin
    frozen_generation: CanvasFrozenGeneration | None = Field(default=None, exclude_if=lambda v: v is None)


class CanvasTextVersion(CanvasContentVersionBase):
    kind: Literal["text"]
    text: str = Field(max_length=40_000)


class CanvasPendingOriginal(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    host_id: str = Field(pattern=r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    project_id: str = Field(pattern=r"^canvas-[a-z0-9-]{8,64}$")
    version_id: str = Field(pattern=r"^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$")


class CanvasMediaVersion(CanvasContentVersionBase):
    pending_shared_original: CanvasPendingOriginal | None = Field(default=None, exclude_if=lambda v: v is None)
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
        if self.origin.kind == "layer_decomposition" and (
            len(parts) < 3 or parts[0] != "outputs" or parts[1] != self.origin.job_id
        ):
            raise ValueError("canvas layer output path does not match its job")
        return self


CanvasContentVersion = Annotated[
    CanvasTextVersion | CanvasMediaVersion,
    Field(discriminator="kind"),
]


_BATCH_LIFT_COLUMNS = 4
_BATCH_LIFT_WIDTH = 320.0
_BATCH_LIFT_GAP = 40.0
# 与前端「编组」一致：成员外框四周留白，上方多留一行给分组名。
_GROUP_PAD_SIDE, _GROUP_PAD_TOP = 24.0, 40.0


def _lift_member_size(version: object) -> dict:
    width = height = None
    if isinstance(version, dict):
        width, height = version.get("width"), version.get("height")
    if not (isinstance(width, (int, float)) and isinstance(height, (int, float)) and width > 0 and height > 0):
        return {"width": _BATCH_LIFT_WIDTH, "height": _BATCH_LIFT_WIDTH}
    node_width, node_height = _BATCH_LIFT_WIDTH, round(_BATCH_LIFT_WIDTH * height / width, 2)
    if node_height > 4000:
        node_width, node_height = round(4000 * width / height, 2), 4000.0
    return {"width": node_width, "height": max(node_height, 1.0)}


def _lift_batch_material_nodes(value: dict) -> dict:
    raw_nodes = value["nodes"]
    versions = value.get("content_versions") if isinstance(value.get("content_versions"), dict) else {}
    used = {node.get("id") for node in raw_nodes if isinstance(node, dict)}
    grouped = {
        member for node in raw_nodes
        if isinstance(node, dict) and node.get("type") == "group" and isinstance(node.get("data"), dict)
        for member in node["data"].get("member_node_ids") or []
    }
    replaced: dict[str, list[str]] = {}
    nodes: list = []
    for node in raw_nodes:
        if not (isinstance(node, dict) and node.get("type") == "batch_material"):
            nodes.append(node)
            continue
        batch_id = node.get("id")
        position = node.get("position") if isinstance(node.get("position"), dict) else {}
        origin_x, origin_y = position.get("x", 0), position.get("y", 0)
        items = (node.get("data") or {}).get("items") or []
        version_ids = [version_id for item in items if isinstance(item, dict)
                       for version_id in item.get("image_version_ids") or []]
        title = node.get("title") or "批量素材"
        members: list[str] = []
        sizes = [_lift_member_size(versions.get(version_id)) for version_id in version_ids]
        row_heights = [max(size["height"] for size in sizes[start:start + _BATCH_LIFT_COLUMNS])
                       for start in range(0, len(sizes), _BATCH_LIFT_COLUMNS)]
        for index, version_id in enumerate(version_ids):
            member_id = f"{batch_id}-{index + 1}"
            while member_id in used:
                member_id = f"{member_id}-b"
            used.add(member_id)
            members.append(member_id)
            row, column = divmod(index, _BATCH_LIFT_COLUMNS)
            nodes.append({
                "id": member_id, "type": "image", "title": f"{title} {index + 1}"[:120],
                "position": {"x": origin_x + column * (_BATCH_LIFT_WIDTH + _BATCH_LIFT_GAP),
                             "y": origin_y + sum(row_heights[:row]) + row * _BATCH_LIFT_GAP},
                "size": sizes[index], "z_index": node.get("z_index", 0),
                "hidden": bool(node.get("hidden", False)), "data": {"current_version_id": version_id},
            })
        replaced[batch_id] = members
        if batch_id not in grouped and members:
            columns = min(len(members), _BATCH_LIFT_COLUMNS)
            nodes.append({
                "id": batch_id, "type": "group", "title": title,
                "position": {"x": origin_x - _GROUP_PAD_SIDE, "y": origin_y - _GROUP_PAD_TOP},
                "size": {
                    "width": columns * _BATCH_LIFT_WIDTH + (columns - 1) * _BATCH_LIFT_GAP + 2 * _GROUP_PAD_SIDE,
                    "height": sum(row_heights) + (len(row_heights) - 1) * _BATCH_LIFT_GAP
                    + _GROUP_PAD_TOP + _GROUP_PAD_SIDE,
                },
                "z_index": node.get("z_index", 0), "data": {"member_node_ids": members},
            })
    if grouped & set(replaced):
        nodes = [
            {**node, "data": {**node["data"], "member_node_ids": [
                member for member_id in node["data"].get("member_node_ids") or []
                for member in replaced.get(member_id, [member_id])]}}
            if isinstance(node, dict) and node.get("type") == "group" and isinstance(node.get("data"), dict)
            else node
            for node in nodes
        ]
    connections = value.get("connections")
    if isinstance(connections, list):
        connections = [edge for edge in connections if not (isinstance(edge, dict) and (
            edge.get("source_node_id") in replaced or edge.get("target_node_id") in replaced))]
    return {**value, "nodes": nodes, "connections": connections}


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

    @model_validator(mode="before")
    @classmethod
    def lift_config_nodes(cls, value: object) -> object:
        # 5.86.0 删除「生成配置」节点：生成设置本来就能放在文本 / 图片 / 视频 / 音频节点上。
        # 已有画布和导出包里的 config 节点按它的生成模式换成对应类型的空节点，连线不变。
        if not isinstance(value, dict) or not isinstance(value.get("nodes"), list):
            return value
        if not any(isinstance(node, dict) and node.get("type") == "config" for node in value["nodes"]):
            return value
        nodes = []
        for node in value["nodes"]:
            draft = node.get("data", {}).get("draft") if isinstance(node, dict) else None
            if isinstance(node, dict) and node.get("type") == "config" and isinstance(draft, dict):
                node = {**node, "type": draft.get("mode"), "data": {"generation_draft": draft}}
            nodes.append(node)
        return {**value, "nodes": nodes}

    @model_validator(mode="before")
    @classmethod
    def lift_batch_material_nodes(cls, value: object) -> object:
        # 删除「批量素材」节点：已有画布和导出包里的批量节点换成普通图片节点（每张图一个），
        # 不在分组里时再用一个同名分组装起来（分组沿用原节点 id）。原节点的连线删除：批量素材
        # 给下游的是「当前项」，换成分组后保留连线会变成「整批同时当参考」，静默改变生成结果。
        # 读时转换不写回磁盘，所以结果只由输入决定：id 按序号生成，坐标按网格算。
        if not isinstance(value, dict) or not isinstance(value.get("nodes"), list):
            return value
        if not any(isinstance(node, dict) and node.get("type") == "batch_material" for node in value["nodes"]):
            return value
        return _lift_batch_material_nodes(value)

    def layer_material_node_ids(self) -> set[str]:
        return {
            node_id for node in self.nodes if node.type == "layer_stack"
            for node_id in [node.data.base_material_node_id, *[
                layer.material_node_id for layer in node.data.layers
            ]] if node_id is not None
        }

    def sync_layer_materials(self) -> "CanvasDocument":
        """Material nodes are the editable view; stack snapshots follow their current images."""
        by_id = {node.id: node for node in self.nodes}
        owners: set[str] = set()

        def material(node_id):
            if node_id is None:
                return None
            node = by_id.get(node_id)
            if node is None:
                return None
            if node.type != "image" or not node.data.current_version_id or node_id in owners:
                raise ValueError("layer material must be one uniquely owned populated image node")
            owners.add(node_id)
            version = self.content_versions.get(node.data.current_version_id)
            if node.size and not node.data.display.free_resize and version is not None \
                    and version.kind == "image" and version.width and version.height:
                longest = max(node.size.width, node.size.height)
                scale = longest / max(version.width, version.height)
                node = node.model_copy(update={"size": CanvasSize(
                    width=max(1, version.width * scale), height=max(1, version.height * scale),
                )})
                by_id[node_id] = node
            return node

        nodes = []
        for node in self.nodes:
            if node.type != "layer_stack":
                nodes.append(node)
                continue
            base = material(node.data.base_material_node_id)
            layout_size = node.data.layout_size
            base_version = self.content_versions.get(node.data.base_version_id or "")
            if base and layout_size is None and base_version is not None \
                    and base_version.kind == "image" and base_version.width and base_version.height:
                layout_size = CanvasGroupSize(width=base_version.width, height=base_version.height)
            layers = []
            for layer in node.data.layers:
                image = material(layer.material_node_id)
                layers.append(layer.model_copy(update={
                    "material_node_id": image.id if image else None,
                    "version_id": image.data.current_version_id if image else layer.version_id,
                    "name": image.title if image else layer.name,
                }))
            nodes.append(node.model_copy(update={"data": node.data.model_copy(update={
                "base_material_node_id": base.id if base else None,
                "layout_size": layout_size,
                "base_version_id": base.data.current_version_id if base else node.data.base_version_id,
                "layers": layers,
            })}))
        self.nodes = [by_id[node.id] if node.id in owners else node for node in nodes]
        return self

    @model_validator(mode="after")
    def validate_graph_references(self) -> "CanvasDocument":
        self.sync_layer_materials()
        node_ids = [node.id for node in self.nodes]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError("canvas node ids must be unique")
        edge_ids = [edge.id for edge in self.connections]
        if len(edge_ids) != len(set(edge_ids)):
            raise ValueError("canvas connection ids must be unique")
        edge_endpoints = [
            (
                edge.role,
                edge.source_node_id,
                edge.target_node_id,
                edge.slot if edge.role == "input" else None,
            )
            for edge in self.connections
        ]
        if len(edge_endpoints) != len(set(edge_endpoints)):
            raise ValueError("canvas connections cannot duplicate role and endpoints")
        nodes_by_id = {node.id: node for node in self.nodes}
        for version_id, version in self.content_versions.items():
            if version_id != version.version_id:
                raise ValueError("canvas content version key must match version_id")
            if version.frozen_generation is not None:
                for row in version.frozen_generation.inputs:
                    if row.version_id is not None:
                        owned = self.content_versions.get(row.version_id)
                        if owned is None or owned.kind != row.kind:
                            raise ValueError("frozen input must reference an owned matching version")
            if version.origin.kind == "user_mask":
                source = self.content_versions.get(version.origin.source_version_id)
                if (
                    version.kind != "image"
                    or source is None
                    or source.kind != "image"
                    or (
                        version.width is not None
                        and source.width is not None
                        and (version.width < source.width if version.origin.expanded_canvas
                             else version.width != source.width)
                    )
                    or (
                        version.height is not None
                        and source.height is not None
                        and (version.height < source.height if version.origin.expanded_canvas
                             else version.height != source.height)
                    )
                ):
                    raise ValueError("canvas user mask references an incompatible source version")
        group_members: set[str] = set()
        for node in self.nodes:
            if node.type == "video" and node.data.annotation:
                raise ValueError("annotations are only supported on image nodes")
            if node.type == "image" and node.data.annotation:
                annotation = node.data.annotation
                source = self.content_versions.get(annotation.version_id)
                rendered = self.content_versions.get(annotation.rendered_version_id or "")
                if source is None or source.kind != "image":
                    raise ValueError("annotation requires an owned source image version")
                if annotation.rendered_version_id is not None:
                    if rendered is None or rendered.kind != "image":
                        raise ValueError("annotation requires an owned rendered image version")
                    if (source.width, source.height) != (rendered.width, rendered.height):
                        raise ValueError("annotation must preserve source image dimensions")
                if annotation.markup_version_id is not None:
                    markup = self.content_versions.get(annotation.markup_version_id)
                    if markup is None or markup.kind != "image" or markup.mime_type != "image/png":
                        raise ValueError("annotation markup requires an owned PNG image version")
                    if (source.width, source.height) != (markup.width, markup.height):
                        raise ValueError("annotation markup must preserve source image dimensions")
            if node.type == "image_edit":
                for linked_id in (node.data.source_node_id, node.data.reference_node_id):
                    linked = nodes_by_id.get(linked_id)
                    if linked is not None and linked.type != "image":
                        raise ValueError("image edit source and reference nodes must be images")
                if node.data.reference_node_id and not node.data.reference_version_id:
                    raise ValueError("image edit reference requires a fixed version")
                source = self.content_versions.get(node.data.source_version_id)
                if source is None or source.kind != "image":
                    raise ValueError("image edit node requires an owned source image version")
                if node.data.reference_version_id is not None:
                    reference = self.content_versions.get(node.data.reference_version_id)
                    if reference is None or reference.kind != "image":
                        raise ValueError("image edit reference must be an owned image version")
                if node.data.mask_version_id is not None:
                    mask = self.content_versions.get(node.data.mask_version_id)
                    if (mask is None or mask.kind != "image" or mask.origin.kind != "user_mask"
                            or mask.origin.source_version_id != source.version_id
                            or mask.origin.expanded_canvas):
                        raise ValueError("image edit mask must belong to its fixed source version")
            if node.type == "layer_stack":
                source = self.content_versions.get(node.data.source_version_id)
                if source is None or source.kind != "image":
                    raise ValueError("layer stack must reference a source image version")
                if node.data.base_version_id is not None:
                    base = self.content_versions.get(node.data.base_version_id)
                    if base is None or base.kind != "image":
                        raise ValueError("layer stack must reference a base image version")
                layer_ids = [layer.id for layer in node.data.layers]
                layer_versions = [layer.version_id for layer in node.data.layers]
                z_indices = [layer.z_index for layer in node.data.layers]
                if node.data.base_version_id is not None:
                    z_indices.append(node.data.base_z_index)
                if (
                    len(layer_ids) != len(set(layer_ids))
                    or len(layer_versions) != len(set(layer_versions))
                    or len(z_indices) != len(set(z_indices))
                ):
                    raise ValueError("layer stack layers must be unique")
                for layer in node.data.layers:
                    version = self.content_versions.get(layer.version_id)
                    if version is None or version.kind != "image":
                        raise ValueError("layer stack must reference image layer versions")
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
        occupied_frame_slots: set[tuple[str, str]] = set()
        layer_stack_inputs: dict[str, int] = {}
        for edge in self.connections:
            if edge.source_node_id not in nodes_by_id or edge.target_node_id not in nodes_by_id:
                raise ValueError("canvas connection references a missing node")
            if edge.source_node_id == edge.target_node_id:
                raise ValueError("canvas connection cannot target itself")
            source = nodes_by_id[edge.source_node_id]
            target = nodes_by_id[edge.target_node_id]
            # 分组可以作为「素材包」整包供参考，所以它是合法的 input 源；但它永远不是终点
            # （分组不接收内容，也不改变资产归属），也不承担首尾帧这类语义槽位——槽位要的是
            # 一张确定的图，一个包给不出这个承诺。
            if edge.role == "input" and edge.mj_role is not None:
                if (source.type != "image" or target.type != "image" or edge.slot is not None
                        or edge.annotated):
                    raise ValueError("Midjourney reference roles require an unslotted image connection")
            if target.type == "group":
                raise ValueError("canvas group nodes cannot receive connections")
            if source.type == "compare":
                raise ValueError("canvas compare nodes cannot provide connections")
            if target.type == "compare":
                # 对比连线只决定显示哪两张图，不是生成参考。
                if (edge.role != "input" or source.type != "image" or edge.annotated
                        or edge.slot not in {"before", "after"}):
                    raise ValueError("canvas compare input must be an image on the before or after slot")
                slot_key = (edge.target_node_id, edge.slot)
                if slot_key in occupied_frame_slots:
                    raise ValueError("canvas compare slot can only have one source")
                occupied_frame_slots.add(slot_key)
                continue
            if edge.role == "input" and edge.slot in {"before", "after"}:
                raise ValueError("before / after slots only connect into compare nodes")
            if source.type == "group" and (edge.role != "input" or edge.slot is not None):
                raise ValueError("canvas group can only be an unslotted input source")
            if edge.role == "material" and (source.type, target.type) not in {
                ("image", "image"), ("image", "image_edit"), ("image_edit", "image"),
            }:
                raise ValueError("canvas material connections require images or image edit nodes")
            if edge.role == "input":
                if edge.annotated and (edge.slot is not None or source.type != "image"):
                    raise ValueError("annotated connections require an unslotted image source")
                if edge.annotation_delivery is not None and not edge.annotated:
                    raise ValueError("annotation delivery requires an annotated connection")
                if source.type in {"plugin", "layer_stack", "image_edit"}:
                    raise ValueError("canvas input source cannot provide content")
                if target.type == "image_edit":
                    raise ValueError("image edit nodes only accept material connections")
                if target.type == "plugin":
                    # 结构上只放行普通输入。插件是否收这种素材、收几条，要看清单，由保存路径对
                    # 新增连线核对（canvas_plugin_rules）；这里不查，停用插件后旧文档才读得出。
                    if edge.slot is not None or edge.annotated:
                        raise ValueError("canvas plugin inputs must be unslotted and unannotated")
                    continue
                if target.type == "layer_stack":
                    if source.type != "image" or edge.slot is not None:
                        raise ValueError("layer stack input must be one image node")
                    layer_stack_inputs[target.id] = layer_stack_inputs.get(target.id, 0) + 1
                    continue
                if edge.slot is not None:
                    target_draft = getattr(target.data, "generation_draft", None)
                    if source.type != "image" or target_draft is None or target_draft.mode != "video":
                        raise ValueError("canvas video frame slots require an image source and video draft")
                    slot_key = (edge.target_node_id, edge.slot)
                    if slot_key in occupied_frame_slots:
                        raise ValueError("canvas video frame slot can only have one source")
                    occupied_frame_slots.add(slot_key)
        if any(count > 1 for count in layer_stack_inputs.values()):
            raise ValueError("layer stack cannot have more than one image input")
        if len(self.model_dump_json().encode("utf-8")) > 25 * 1024 * 1024:
            raise ValueError("canvas document exceeds 25 MiB")
        return self


CategoryName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=24)]
OptionalCategory = Annotated[
    CategoryName | None,
    BeforeValidator(lambda value: None if isinstance(value, str) and not value.strip() else value),
]
DEFAULT_CANVAS_CATEGORIES = ["弹窗", "角色", "底图", "按钮", "图标", "字效"]


class CanvasCategoriesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    categories: list[CategoryName] = Field(max_length=40)

    @field_validator("categories")
    @classmethod
    def unique_categories(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))


class CanvasProject(CanvasCategoriesUpdate):
    migrated_from_workshop: str | None = Field(default=None, min_length=1, max_length=120)
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[2] = 2
    project_id: str
    name: CanvasProjectName
    categories: list[CategoryName] = Field(default_factory=lambda: DEFAULT_CANVAS_CATEGORIES.copy(), max_length=40)
    category_spec_files: dict[CategoryName, Annotated[str, Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*\.md$")]] = Field(default_factory=dict)
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def unique_spec_files(self):
        filenames = list(self.category_spec_files.values())
        if "project.md" in filenames or len(set(filenames)) != len(filenames):
            raise ValueError("类别规范文件名必须唯一且不能为 project.md")
        return self


class CanvasSpecUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=40_000)


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


_CANVAS_AGENT_DATA_URL = re.compile(r"data:[a-z0-9.+-]+/[a-z0-9.+-]+;", re.IGNORECASE)


def redact_canvas_agent_private_text(value: str) -> str:
    """模型输出不受我们控制：落盘前把会被拒收的片段替换掉，而不是让整轮对话写盘失败。"""
    return _CANVAS_AGENT_PRIVATE_TEXT.sub(" [已隐藏]", value)


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


CanvasAgentStatus = Literal["idle", "running", "awaiting_approval", "interrupted", "failed"]
CanvasAgentPermissionMode = Literal["review", "auto"]
# 全能：按需求出图或出视频；图像 / 视频创作：只用对应类型的模型。
CanvasAgentCreationMode = Literal["all", "image", "video"]


class CanvasAgentModelRef(BaseModel):
    """模型偏好里的一项生成模型；同名模型可能挂在多个 Key 下，按别名 + 模型成对记。
    alias 为 None =「自动」：model 是路由 id，生成时按组内顺序解析 KEY。"""
    model_config = ConfigDict(extra="forbid")
    alias: str | None = Field(default=None, min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=200)


class CanvasAgentApproval(BaseModel):
    """一次待确认的工具调用；会话停在 awaiting_approval，直到用户逐条执行或拒绝。"""
    model_config = ConfigDict(extra="forbid")
    call_id: str = Field(min_length=1, max_length=200)
    tool: str = Field(min_length=1, max_length=80)
    arguments: str = Field(max_length=200_000)
    summary: str = Field(max_length=4000)


class AgentSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    revision: int = Field(default=0, ge=0)
    sequence: int = Field(default=0, ge=0)
    session_id: CanvasAgentSessionId
    title: CanvasProjectName
    status: CanvasAgentStatus = "idle"
    model: str | None = Field(default=None, min_length=1, max_length=160)
    # 对话模型所在的 Key 别名；同名模型可能挂在多个聚合商下，必须和模型成对保存。
    model_alias: str | None = Field(default=None, min_length=1, max_length=120)
    effort: Literal["low", "medium", "high", "xhigh"] | None = None
    # 默认 Auto：所有写操作（建节点、出图、修改、删除）直接执行，不弹确认。
    permission_mode: CanvasAgentPermissionMode = "auto"
    creation_mode: CanvasAgentCreationMode = "all"
    # 自动：Agent 从全部可用生成模型里挑；关掉后只能用 preferred_models 里的（一个都没选就不能生成）。
    # 重新打开自动不清空 preferred_models，再关掉时恢复用户上次的选择。
    auto_models: bool = True
    preferred_models: list[CanvasAgentModelRef] = Field(default_factory=list, max_length=200)
    token_usage: CanvasAgentTokenUsage = Field(default_factory=CanvasAgentTokenUsage)
    messages: list[CanvasAgentMessage] = Field(default_factory=list, max_length=20_000)
    # 发给模型的上下文（OpenAI Agents SDK 的 input items）；图片只存 atelier-media 引用。
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=20_000)
    pending_approvals: list[CanvasAgentApproval] = Field(default_factory=list, max_length=50)
    error: str | None = Field(default=None, max_length=4000)
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def validate_message_sequence(self) -> "AgentSession":
        _reject_canvas_agent_private_text(self.title, self.model, self.model_alias)
        if _CANVAS_AGENT_DATA_URL.search(json.dumps(self.history, ensure_ascii=False)):
            raise ValueError("canvas agent history cannot persist data URLs")
        message_ids = [message.message_id for message in self.messages]
        sequences = [message.sequence for message in self.messages]
        if len(message_ids) != len(set(message_ids)) or len(sequences) != len(set(sequences)):
            raise ValueError("canvas agent message ids and sequences must be unique")
        if sequences != sorted(sequences):
            raise ValueError("canvas agent messages must be stored in sequence order")
        if sequences and sequences[-1] > self.sequence:
            raise ValueError("canvas agent session sequence is behind its messages")
        return self


class CanvasAgentSession(AgentSession):
    project_id: str = Field(pattern=r"^canvas-[a-z0-9-]{8,64}$")
    # 本会话新建的节点：Auto 模式下改它们算「新增」，不打断用户。
    created_node_ids: list[str] = Field(default_factory=list, max_length=5000)


class StudioAgentStep(BaseModel):
    step_id: str
    tool: str
    summary: str
    status: Literal["running", "completed", "failed", "interrupted", "rejected"]


class StudioAgentTurn(BaseModel):
    turn_id: str
    client_message_id: str
    status: CanvasAgentStatus = "running"
    attachment_ids: list[str] = Field(default_factory=list)
    asset_ids: list[str] = Field(default_factory=list)
    steps: list[StudioAgentStep] = Field(default_factory=list)


class StudioAgentSession(AgentSession):
    turns: list[StudioAgentTurn] = Field(default_factory=list)
    uploads: dict[str, str] = Field(default_factory=dict)


class CanvasAgentSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: CanvasProjectName = "新对话"


class CanvasAgentSessionUpdate(BaseModel):
    """面板上的会话设置；未给的字段不变。model 与 model_alias 必须一起给。"""
    model_config = ConfigDict(extra="forbid")
    title: CanvasProjectName | None = None
    model: str | None = Field(default=None, min_length=1, max_length=160)
    model_alias: str | None = Field(default=None, min_length=1, max_length=120)
    effort: Literal["low", "medium", "high", "xhigh", "off"] | None = None
    permission_mode: CanvasAgentPermissionMode | None = None
    creation_mode: CanvasAgentCreationMode | None = None
    auto_models: bool | None = None
    preferred_models: list[CanvasAgentModelRef] | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def model_pairs_with_alias(self) -> "CanvasAgentSessionUpdate":
        if (self.model is None) != (self.model_alias is None):
            raise ValueError("model and model_alias must be set together")
        return self


class CanvasAgentTurnCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=40_000)
    # 用户从画布带进对话的节点；图片节点会把当前版本作为图片发给模型。
    node_ids: list[str] = Field(default_factory=list, max_length=16)
    # 用户在输入框点选的 Skill：本轮把它的说明附在消息里。
    skill: str | None = Field(default=None, min_length=1, max_length=64)


class CanvasAgentApprovalDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    call_id: str = Field(min_length=1, max_length=200)
    approve: bool
    # 批量生成（run_generations）里勾选执行的项（下标）；不给就是全部执行。只在请求里出现，不落盘。
    items: list[Annotated[int, Field(ge=0, le=19)]] | None = Field(default=None, min_length=1,
                                                                   max_length=20)


class CanvasAgentBatchItemReference(BaseModel):
    """确认卡上一项生成的参考图（画布节点的当前版本）：显示缩略图，点一下定位到节点。"""
    model_config = ConfigDict(extra="forbid")
    node_id: str
    version_id: str
    title: str


class CanvasAgentBatchItem(BaseModel):
    """生成确认卡的一项（只在响应里，不落盘）；估价按打开卡片时的 draft 现算，None = 未计价。
    prompt 是截断后的提示词开头；画布单次生成也按一项返回。"""
    model_config = ConfigDict(extra="forbid")
    index: int = Field(ge=0, le=19)
    node_id: str
    title: str
    model: str | None = None
    count: int = Field(ge=1)
    estimate_cny: float | None = None
    prompt: str | None = None
    references: list[CanvasAgentBatchItemReference] = Field(default_factory=list, max_length=4)


class CanvasAgentBatchItems(BaseModel):
    model_config = ConfigDict(extra="forbid")
    turn_estimate_cny: float | None = None
    confirm_above_cny: float
    items: list[CanvasAgentBatchItem] = Field(max_length=20)


CanvasAgentPlanStatus = Literal["pending", "in_progress", "completed"]


class CanvasAgentPlanItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=80)
    status: CanvasAgentPlanStatus = "pending"


class CanvasAgentPlan(BaseModel):
    """Agent 的待办（update_plan）：存会话旁的 `canvases/<id>/agent/plans/<session_id>.json`，
    不进 CanvasAgentSession（会话模型 extra=forbid，加字段会让回滚后的旧版本读不出会话，ADR-0030）。"""
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    items: list[CanvasAgentPlanItem] = Field(max_length=12)
    updated_at: str


class CanvasAgentApprovalsSubmit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decisions: list[CanvasAgentApprovalDecision] = Field(min_length=1, max_length=50)


class CanvasAgentSessionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: CanvasAgentSessionId
    project_id: str = Field(pattern=r"^canvas-[a-z0-9-]{8,64}$")
    title: CanvasProjectName
    status: CanvasAgentStatus
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
    # 单轴切分（1 行 N 列 / N 行 1 列）合法，但两轴都没有切线就是原图，拒绝。
    horizontal_lines: list[CanvasSplitLine] = Field(max_length=11)
    vertical_lines: list[CanvasSplitLine] = Field(max_length=11)

    @model_validator(mode="after")
    def _require_a_cut(self) -> "CanvasSplitMediaOperation":
        if not self.horizontal_lines and not self.vertical_lines:
            raise ValueError("切分至少需要一条切线。")
        return self


class CanvasRemoveBackgroundMediaOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["remove_background"]


CanvasMediaOperation = Annotated[
    CanvasCropMediaOperation | CanvasSplitMediaOperation | CanvasRemoveBackgroundMediaOperation,
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


class CanvasTextRevisionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    instruction: str = Field(min_length=1, max_length=2000)
    selection_start: int | None = Field(default=None, ge=0)
    selection_end: int | None = Field(default=None, ge=0)
    alias: str | None = Field(default=None, max_length=120)
    model: str = Field(min_length=1, max_length=240)


class CanvasLayerDecompositionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    alias: str = Field(min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=240)


class CanvasImageEditOptions(CanvasImageEditSettings):
    source_version_id: str | None = Field(default=None, max_length=120)
    reference_node_id: str | None = Field(default=None, max_length=120)


class CanvasImageEditSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    node_id: str | None = Field(default=None, max_length=120)
    source_node_id: str | None = Field(default=None, max_length=120)
    source_version_id: str | None = Field(default=None, max_length=160)
    reference_node_id: str | None = Field(default=None, max_length=120)
    reference_version_id: str | None = Field(default=None, max_length=160)
    generation_draft: CanvasGenerationDraft | None = None
    options: CanvasImageEditSettings = Field(default_factory=CanvasImageEditSettings)
    editor_state: CanvasImageEditEditorState = Field(default_factory=CanvasImageEditEditorState)


class CanvasImageEditSaveResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document: CanvasDocument
    node_id: str


class CanvasImageEditRunCreate(BaseModel):
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


class CanvasUpscaleRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    target: CanvasUpscaleTarget


class CanvasUpscaleEstimateRequest(BaseModel):
    """AI高清菜单的纯估价：与 CanvasUpscaleRunCreate 同一个源图节点，一次问几档；不建任务、不计费。"""
    model_config = ConfigDict(extra="forbid")
    surface_node_id: str = Field(min_length=1, max_length=120)
    targets: list[CanvasUpscaleTarget] = Field(min_length=1, max_length=3)


class CanvasUpscaleEstimateResponse(BaseModel):
    """每档的预计费用（元，与 /api/pricing/estimate 同口径）；未计价或这一档提交会被拒绝时为 null。"""
    model_config = ConfigDict(extra="forbid")
    estimates: dict[CanvasUpscaleTarget, float | None]


class CanvasRunResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job: Job
    document: CanvasDocument


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


class CreationPromptTextSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["text"]
    text: str = Field(min_length=1, max_length=40_000)


class CreationPromptVariableSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["variable"]
    name: str = Field(min_length=1, max_length=40)
    default_value: str = Field(min_length=1, max_length=40_000)


CreationPromptSegment = Annotated[
    CreationPromptTextSegment | CreationPromptVariableSegment,
    Field(discriminator="kind"),
]


class PromptPreviewImage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file: str = Field(pattern=r"^[a-f0-9]{16}\.(png|jpg|webp|gif)$")
    mime_type: str
    width: int
    height: int
    source_job_id: str | None = None
    source_model: str | None = None
    added_at: str


class CreationPromptAssetContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["prompt"]
    segments: list[CreationPromptSegment] = Field(min_length=1, max_length=400)
    preview_images: list[PromptPreviewImage] = Field(default_factory=list)

    @model_serializer(mode="wrap")
    def _omit_empty_previews(self, handler):
        data = handler(self)
        if not self.preview_images:
            data.pop("preview_images", None)
        return data


MEDIA_MIME_PATTERN = r"^(image|video|audio)/"
# 创作资产 blob 能存的媒体类型 → 后缀；快照参考只收这张表里的类型，否则 blob 路径算不出来。
MEDIA_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
}
TEAM_RECIPE_INPUT_PATH_PATTERN = r"^refs/[0-9]{2}-[a-f0-9]{12}\.[a-z0-9]{2,5}$"
SHA256_PATTERN = r"^[a-f0-9]{64}$"
TEAM_LIBRARY_ID_PATTERN = r"^lib_[a-f0-9]{16}$"
TEAM_ASSET_ID_PATTERN = r"^ta_[0-9A-HJKMNP-TV-Z]{26}$"


class CreationMediaAssetContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["media"]
    path: str = Field(min_length=1)
    mime_type: str = Field(pattern=MEDIA_MIME_PATTERN)
    bytes: int = Field(ge=1)
    sha256: str = Field(pattern=SHA256_PATTERN)
    filename: str = Field(min_length=1, max_length=255)
    width: int | None = None
    height: int | None = None

    @model_serializer(mode="wrap")
    def _omit_unknown_dimensions(self, handler):
        data = handler(self)
        for field in ("width", "height"):
            if data.get(field) is None:
                data.pop(field, None)
        return data


RecipeInputRole = Literal["reference", "mask", "markup", "mj_sref", "mj_cref", "mj_oref"]
RecipeMediaKind = Literal["image", "video", "audio"]


class RecipeInput(BaseModel):
    """冻结快照里的一份参考：本体按 sha256 进 blobs，不引用任何本机路径。"""
    model_config = ConfigDict(extra="forbid")
    order: int = Field(ge=0)
    role: RecipeInputRole
    kind: RecipeMediaKind
    sha256: str = Field(pattern=SHA256_PATTERN)
    mime_type: str = Field(pattern=MEDIA_MIME_PATTERN)

    @model_validator(mode="after")
    def validate_mime(self) -> "RecipeInput":
        if self.mime_type not in MEDIA_SUFFIXES:
            raise ValueError(f"参考的媒体类型不受支持：{self.mime_type}")
        if self.mime_type.split("/", 1)[0] != self.kind:
            raise ValueError("参考的 kind 与 mime_type 不一致")
        return self


def _check_input_orders(inputs: list[RecipeInput]) -> None:
    orders = [row.order for row in inputs]
    if orders != list(range(len(orders))):
        raise ValueError("参考的 order 必须按升序从 0 连续编号")


class _RecipeFields(BaseModel):
    """GenerationRecipe（本机）与 TeamGenerationSnapshot（团队库）共用的快照字段；只差 inputs 形状。"""
    mode: Literal["image", "video"]
    model: str = Field(min_length=1, max_length=200)
    provider: str | None = None
    alias: str | None = None
    final_prompt: str
    draft_prompt: str | None = None
    # 提交时的参数，已去掉路径 / 费用 / 运行态字段（分享时由 team_library_share 清洗）。
    params: dict[str, Any] = Field(default_factory=dict)
    cost_cny: float | None = Field(default=None, ge=0)
    cost_basis: Literal["actual", "estimated"] | None = None
    submitted_at: str

    @model_validator(mode="after")
    def validate_cost_pair(self) -> "_RecipeFields":
        if (self.cost_cny is None) != (self.cost_basis is None):
            raise ValueError("cost_cny 与 cost_basis 必须同时为空或同时有值")
        return self


class GenerationRecipe(_RecipeFields):
    """生成资产的本机冻结快照：自包含，参考按 sha256 引用 blobs（不同于画布按 version_id 引用）。"""
    model_config = ConfigDict(extra="forbid")
    inputs: list[RecipeInput] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def validate_input_orders(self) -> "GenerationRecipe":
        _check_input_orders(self.inputs)
        return self


class CreationGenerationAssetContent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["generation"]
    media: CreationMediaAssetContent
    snapshot: GenerationRecipe


CreationAssetContent = Annotated[
    CreationPromptAssetContent | CreationMediaAssetContent | CreationGenerationAssetContent,
    Field(discriminator="kind"),
]


class AdoptionOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    library_id: str = Field(pattern=TEAM_LIBRARY_ID_PATTERN)
    asset_id: str = Field(min_length=1, max_length=160)
    source_updated_at: str
    raw_path: str | None = None
    source_preview_fingerprint: str | None = None

    @model_serializer(mode="wrap")
    def _omit_empty_preview_fingerprint(self, handler):
        data = handler(self)
        if self.source_preview_fingerprint is None:
            data.pop("source_preview_fingerprint", None)
        return data


class CanvasClassifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_ids: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(min_length=1, max_length=48)
    model_alias: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=200)


class CanvasCategorySuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str
    category: CategoryName | None
    confidence: float = Field(ge=0, le=1)


class CreationAssetMetadataUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: OptionalCategory


class CreationAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str = Field(min_length=1, max_length=160)
    kind: Literal["prompt", "media", "generation"]
    title: str = Field(min_length=1, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=20)
    created_at: str
    updated_at: str
    last_used_at: str | None = None
    use_count: int = Field(default=0, ge=0)
    content: CreationAssetContent
    category: OptionalCategory = None
    project_ids: list[str] = Field(default_factory=list)
    adopted_from: AdoptionOrigin | None = None

    @model_serializer(mode="wrap")
    def _omit_unused_count(self, handler):
        data = handler(self)
        if data.get("use_count") == 0:
            data.pop("use_count", None)
        return data

    @model_validator(mode="after")
    def validate_content_identity(self) -> "CreationAsset":
        if self.content.kind != self.kind:
            raise ValueError("creation asset content must match asset kind")
        if len(self.project_ids) != len(set(self.project_ids)):
            raise ValueError("creation asset project ids must be unique")
        return self


class CreationAssetCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[4] = 4
    revision: int = Field(default=0, ge=0)
    updated_at: str
    assets: list[CreationAsset] = Field(default_factory=list)
    migrated_canvas_project_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_asset_identity(self) -> "CreationAssetCatalog":
        asset_ids = [asset.asset_id for asset in self.assets]
        if len(asset_ids) != len(set(asset_ids)):
            raise ValueError("creation asset ids must be unique")
        return self


class CreationAssetList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    assets: list[CreationAsset]


class CreationPromptAssetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    segments: list[CreationPromptSegment] = Field(min_length=1, max_length=400)
    tags: list[str] = Field(default_factory=list, max_length=20)
    project_id: str | None = Field(default=None, min_length=1, max_length=160)


class CreationPromptAssetUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    segments: list[CreationPromptSegment] = Field(min_length=1, max_length=400)
    tags: list[str] = Field(default_factory=list, max_length=20)


class CreationMediaPathCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    source_path: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list, max_length=20)
    project_id: str | None = Field(default=None, min_length=1, max_length=160)
    allow_existing: bool = False
    category: OptionalCategory = None


class CreationAssetUseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str | None = Field(default=None, min_length=1, max_length=160)


class CanvasLibraryInsertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position: CanvasPoint


class CanvasCreationAssetInsertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position: CanvasPoint
    variable_values: dict[str, str] = Field(default_factory=dict)
    target_node_id: str | None = Field(default=None, min_length=1, max_length=160)


class CanvasReproduceRequest(BaseModel):
    """画布复刻；model 为 null 时配置节点模型位留空（本机没有配方里的模型）。"""
    model_config = ConfigDict(extra="forbid")
    position: CanvasPoint
    alias: str | None = None
    model: str | None = None


class CanvasPasteRequest(BaseModel):
    """跨画布粘贴：节点 id 已由前端换新，服务端复制媒体版本并改写引用。"""
    model_config = ConfigDict(extra="forbid")
    source_project_id: str = Field(min_length=1)
    nodes: list[CanvasNode] = Field(min_length=1, max_length=500)
    connections: list[CanvasConnection] = Field(default_factory=list, max_length=2_000)


class CanvasReproduceResponse(CanvasDocument):
    """与 creation asset insert 路由的响应（CanvasDocument）同形状，另加 warnings。

    只作响应：warnings 不属于画布文档，不能当 CanvasDocument 落盘。
    """
    warnings: list[str] = Field(default_factory=list)


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

    @field_validator("params")
    @classmethod
    def reject_explicit_null_params(cls, value: JobParams | None) -> JobParams | None:
        if value is None:
            raise ValueError("params cannot be null")
        return value


class ClipboardAttempt(BaseModel):
    ts: str
    success: bool
    reason: str | None = None


class UserProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(min_length=1, max_length=40)


class TeamLibraryManifest(BaseModel):
    """挂载目录里唯一被写入的文件 `.atelier-library.json`。

    团队侧文件来自别人的机器：读模型一律 extra="ignore"，新版本多写的字段不让本机读挂。
    """
    model_config = ConfigDict(extra="ignore")
    format_version: Literal[1] = 1
    library_id: str = Field(pattern=TEAM_LIBRARY_ID_PATTERN)
    name: str = Field(min_length=1, max_length=120)
    created_at: str
    created_by: str = Field(min_length=1, max_length=40)


class TeamAssetAuthor(BaseModel):
    model_config = ConfigDict(extra="ignore")
    display_name: str = Field(min_length=1, max_length=40)


class TeamAssetMedia(BaseModel):
    model_config = ConfigDict(extra="ignore")
    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(pattern=MEDIA_MIME_PATTERN)
    bytes: int = Field(ge=1)
    sha256: str = Field(pattern=SHA256_PATTERN)


class TeamRecipeInput(RecipeInput):
    """团队库里的参考：多一个相对资产目录的路径，白名单只认 asset.json 布局的 refs/NN-<sha12>.<ext>。"""
    model_config = ConfigDict(extra="ignore")
    path: str = Field(pattern=TEAM_RECIPE_INPUT_PATH_PATTERN)


class TeamGenerationSnapshot(_RecipeFields):
    """asset.json 里的 snapshot。转本机快照：
    GenerationRecipe.model_validate(snapshot.model_dump(exclude={"inputs": {"__all__": {"path"}}}))
    """
    model_config = ConfigDict(extra="ignore")
    inputs: list[TeamRecipeInput] = Field(default_factory=list, max_length=64)

    @model_validator(mode="after")
    def validate_input_orders(self) -> "TeamGenerationSnapshot":
        _check_input_orders(self.inputs)
        return self


# from_attributes：分享时直接传本机 CreationPromptAssetContent 实例也能写进 TeamAssetFile。
class TeamPromptTextSegment(CreationPromptTextSegment):
    model_config = ConfigDict(extra="ignore", from_attributes=True)


class TeamPromptVariableSegment(CreationPromptVariableSegment):
    model_config = ConfigDict(extra="ignore", from_attributes=True)


TeamPromptSegment = Annotated[
    TeamPromptTextSegment | TeamPromptVariableSegment,
    Field(discriminator="kind"),
]


class TeamPromptPreviewImage(PromptPreviewImage):
    model_config = ConfigDict(extra="ignore", from_attributes=True)


class TeamPromptContent(CreationPromptAssetContent):
    """asset.json 里的 prompt：团队侧宽松读（R1）。继承本机模型，采用时可直接作为 content。"""
    model_config = ConfigDict(extra="ignore", from_attributes=True)
    segments: list[TeamPromptSegment] = Field(min_length=1, max_length=400)
    preview_images: list[TeamPromptPreviewImage] = Field(default_factory=list)


class TeamAssetOrigin(BaseModel):
    """只作追溯，不解析。"""
    model_config = ConfigDict(extra="ignore")
    job_id: str | None = None
    canvas_project_id: str | None = None


def _lenient_team_category(value: Any) -> str | None:
    """别的工具写坏的类别只当没有，不让整条团队资产读不出来。"""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= 24 else None


TeamCategory = Annotated[str | None, BeforeValidator(_lenient_team_category)]


class TeamAssetFile(BaseModel):
    """分享资产的 `<asset_id>/asset.json`。"""
    model_config = ConfigDict(extra="ignore")
    team_asset_version: Literal[1] = 1
    asset_id: str = Field(pattern=TEAM_ASSET_ID_PATTERN)
    kind: Literal["generation", "media", "prompt"]
    title: str = Field(min_length=1, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=20)
    category: TeamCategory = None
    author: TeamAssetAuthor
    shared_at: str
    updated_at: str
    media: TeamAssetMedia | None = None
    prompt: TeamPromptContent | None = None
    snapshot: TeamGenerationSnapshot | None = None
    origin: TeamAssetOrigin | None = None

    @model_validator(mode="after")
    def validate_kind_payload(self) -> "TeamAssetFile":
        if self.kind in {"generation", "media"} and self.media is None:
            raise ValueError("媒体或生成资产必须带 media")
        if self.kind == "prompt" and self.prompt is None:
            raise ValueError("提示词资产必须带 prompt")
        if self.kind == "generation" and self.snapshot is None:
            raise ValueError("生成资产必须带 snapshot")
        return self


class TeamLibraryMount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    library_id: str = Field(pattern=TEAM_LIBRARY_ID_PATTERN)
    project_id: str = Field(min_length=1, max_length=160)
    mount_path: str
    name: str = Field(min_length=1, max_length=120)
    mounted_at: str


class TeamLibraryMountFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    mounts: list[TeamLibraryMount] = Field(default_factory=list)


class TeamLibraryIndexEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    kind: Literal["generation", "media", "prompt", "raw"]
    title: str
    author: str | None = None
    tags: list[str] = Field(default_factory=list)
    category: str | None = None
    mime_type: str | None = None
    bytes: int = Field(ge=0)
    relative_path: str
    sha256: str | None = None
    updated_at: str
    reproducible: bool
    status: Literal["ready", "incomplete"]
    # 仅 generation 有值：团队栏卡片直接显示模型与花费，不必再读 asset.json。
    model: str | None = None
    cost_cny: float | None = None
    # 仅 generation 有值：snapshot.inputs[].sha256，按 order（推荐 a 按参考 sha 查配方）。
    input_sha256: list[str] = Field(default_factory=list)
    # 提示词列表的正文预览；普通媒体与旧索引不写入此字段。
    prompt_text: str | None = None
    preview_images: list[TeamPromptPreviewImage] = Field(default_factory=list)

    @model_serializer(mode="wrap")
    def _omit_empty_prompt_text(self, handler):
        data = handler(self)
        if self.prompt_text is None:
            data.pop("prompt_text", None)
        if not self.preview_images:
            data.pop("preview_images", None)
        return data


class TeamLibraryIndex(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    library_id: str = Field(pattern=TEAM_LIBRARY_ID_PATTERN)
    scanned_at: str
    entries: list[TeamLibraryIndexEntry] = Field(default_factory=list)


class TeamLibraryView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    library_id: str = Field(pattern=TEAM_LIBRARY_ID_PATTERN)
    project_id: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=120)
    mount_path: str
    mounted_at: str
    reachable: bool
    asset_count: int = Field(ge=0)
    scanned_at: str | None = None


class TeamLibraryAssetPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entries: list[TeamLibraryIndexEntry] = Field(default_factory=list)
    next_cursor: str | None = None


class TeamLibraryMountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(min_length=1, max_length=160)
    path: str = Field(min_length=1)
    name: str | None = Field(default=None, min_length=1, max_length=120)


class TeamAssetAdoptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str | None = Field(default=None, min_length=1, max_length=160)


class TeamAssetAdoptResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset: CreationAsset
    created: bool


class TeamShareJobOutput(BaseModel):
    """Studio 历史的单张结果；output_index 是 Job.output_paths 的下标。"""
    model_config = ConfigDict(extra="forbid")
    kind: Literal["job_output"]
    job_id: str = Field(min_length=1, max_length=160)
    output_index: int = Field(ge=0)


class TeamShareCreationAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["creation_asset"]
    asset_id: str = Field(min_length=1, max_length=160)


class TeamShareCanvasResult(BaseModel):
    """画布结果节点的一个版本；version_id 是 CanvasDocument.content_versions 的键。"""
    model_config = ConfigDict(extra="forbid")
    kind: Literal["canvas_result"]
    canvas_project_id: str = Field(min_length=1, max_length=160)
    node_id: str = Field(min_length=1, max_length=160)
    version_id: str = Field(min_length=1, max_length=160)


TeamShareSource = Annotated[
    TeamShareJobOutput | TeamShareCreationAsset | TeamShareCanvasResult,
    Field(discriminator="kind"),
]


class TeamShareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: TeamShareSource
    title: str = Field(min_length=1, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=20)
    category: OptionalCategory = None
    allow_large: bool = False


class TeamAssetUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    tags: list[str] = Field(max_length=20)
    category: OptionalCategory = None


class TeamRelatedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    library_id: str = Field(pattern=TEAM_LIBRARY_ID_PATTERN)
    library_name: str
    entry: TeamLibraryIndexEntry


CreationAssetStalenessStatus = Literal["fresh", "stale", "withdrawn", "unknown"]


class CreationAssetStaleness(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: CreationAssetStalenessStatus


class CreationAssetStalenessBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_ids: list[str] = Field(min_length=1, max_length=200)


class CreationAssetStalenessBatch(BaseModel):
    """不存在的 asset_id 不出现在 statuses 里。"""
    model_config = ConfigDict(extra="forbid")
    statuses: dict[str, CreationAssetStalenessStatus]


TeamLibraryChangeKind = Literal["added", "updated", "removed"]


class TeamLibraryChangeEvent(BaseModel):
    """SSE team-library-changed 载荷（broadcast 时 model_dump(mode="json")）。

    removed 事件的 title / status / mime_type 为 None。
    """
    model_config = ConfigDict(extra="forbid")
    library_id: str
    asset_id: str
    kind: str
    author: str | None
    change: TeamLibraryChangeKind
    title: str | None = None
    status: Literal["ready", "incomplete"] | None = None
    mime_type: str | None = None


class ModelRouteMemberStatus(BaseModel):
    modality: str
    alias: str
    reason: str = "insufficient_balance"
    since: str | None
    next_probe_at: str
    route_ids: list[str]


class UnavailableModelRoute(BaseModel):
    id: str
    name: str
    modality: str


class ModelRouteMemberStatusResponse(BaseModel):
    members: list[ModelRouteMemberStatus]
    unavailable_routes: list[UnavailableModelRoute]


class UsageTotals(BaseModel):
    cost_cny: float
    unpriced: int
    previous_cost_cny: float | None
    count: int
    by_kind: dict[str, int]
    failed: int
    active_members: int | None
    member_count: int | None


class UsageTrend(BaseModel):
    start: str
    cost_cny: float


class UsageRankingRow(BaseModel):
    key: str
    label: str
    cost_cny: float
    count: int
    unpriced: int


class UsageRanking(BaseModel):
    by: Literal["model", "project", "member"]
    rows: list[UsageRankingRow]


class UsageTask(BaseModel):
    id: str
    cost_cny: float | None  # None = 未计价
    at: str
    kind: str
    model: str
    label: str
    source: Literal["local", "lan"]
    alias: str | None
    status: str
    duration_s: float | None
    project_label: str | None
    member_label: str | None
    project_key: str | None
    member_key: str | None
    prompt: str | None = None
    thumb_url: str | None
    href: str | None


class UsageTasksResponse(BaseModel):
    rows: list[UsageTask]
    total: int
    next_offset: int | None


class UsageMember(BaseModel):
    id: str
    name: str


class UsageResponse(BaseModel):
    scope: Literal["mine", "team"]
    range: Literal["today", "7d", "30d", "90d", "all"]
    bucket: Literal["day", "week"]
    totals: UsageTotals
    trend: list[UsageTrend]
    rankings: list[UsageRanking]
    sources: list[Literal["local", "lan"]]
    members: list[UsageMember]
