"""Persisted shared generation status attached to the host's result node."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CanvasCollabRun(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str = Field(pattern=r"^run-[a-f0-9]{24}$")
    source_node_id: str = Field(min_length=1, max_length=120)
    status: Literal["pending", "done", "failed", "interrupted"] = "pending"
    execution_mode: Literal["guest", "borrowed"] = "guest"
    initiated_by: str = Field(min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=240)
    mode: Literal["image", "video", "audio", "text"]
    started_at: str
    error: str | None = Field(default=None, max_length=400)
