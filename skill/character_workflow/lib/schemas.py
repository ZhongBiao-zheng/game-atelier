"""Pydantic schemas — single source of truth for Python.
对应 web/src/schema/jobs.ts，任何改动两边同步。
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class JobParams(BaseModel):
    model_config = ConfigDict(extra="allow")
    size: str | None = None
    steps: int | None = None
    cfg_scale: float | None = None


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
