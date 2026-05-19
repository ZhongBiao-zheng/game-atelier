"""Pydantic schemas — single source of truth for Python.
对应 web/src/schema/jobs.ts，任何改动两边同步。
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class JobStatus(str, Enum):
    # PENDING_CONFIRM = Skill 已组装好调用参数、等画师在终端或 Web 点确认。
    # PENDING = 已确认 & in-flight（Skill 同步调 lovart 期间停在此状态）。
    PENDING_CONFIRM = "pending_confirm"
    PENDING = "pending"
    DONE = "done"
    FAILED = "failed"


class JobKind(str, Enum):
    # PORTRAIT 立绘（Skill #1）/ PROMO 美宣图（Skill #2）/ TURNAROUND 三视图（Skill #3）。
    # 写盘按 kind 分发到 characters/<id>/<kind>/。旧 job 无字段 → 默认 PORTRAIT。
    PORTRAIT = "portrait"
    PROMO = "promo"
    TURNAROUND = "turnaround"


class JobParams(BaseModel):
    model_config = ConfigDict(extra="allow")
    size: str | None = None
    steps: int | None = None
    cfg_scale: float | None = None
    # 出图卡片展示用 —— 让画师在确认前看到完整调用细节
    vendor: str | None = None
    n: int | None = None
    reference_images: list[str] | None = None


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
    # Skill 套件扩展（2026-05-19）：旧 json 无字段时 Pydantic 自动 fallback。
    kind: JobKind = JobKind.PORTRAIT
    source_image: str | None = None  # promo/turnaround 用，绝对路径


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
