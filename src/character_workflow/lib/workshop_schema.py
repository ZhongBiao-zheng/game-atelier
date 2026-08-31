"""Strict external Workshop inputs; provider-owned JobParams never cross this boundary."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


Identifier = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$")]
IdempotencyKey = Annotated[str, StringConstraints(min_length=8, max_length=120,
                                                pattern=r"^[A-Za-z0-9_-]+$")]


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CharacterTarget(StrictInput):
    type: Literal["character"]
    project_id: Identifier
    character_id: Identifier
    asset_slot: Literal["portrait", "promo", "turnaround"]


class UiTarget(StrictInput):
    type: Literal["ui"]
    project_id: Identifier
    ui_scheme_id: Identifier
    screen_id: Identifier


class VideoTarget(StrictInput):
    type: Literal["video"]
    project_id: Identifier
    production_id: Identifier


class ProjectTarget(StrictInput):
    type: Literal["project"]
    project_id: Identifier


class UiSchemeTarget(StrictInput):
    type: Literal["ui_scheme"]
    project_id: Identifier
    ui_scheme_id: Identifier


GenerationTarget = Annotated[CharacterTarget | UiTarget | VideoTarget, Field(discriminator="type")]
WorkshopTarget = Annotated[
    CharacterTarget | UiTarget | VideoTarget | ProjectTarget | UiSchemeTarget,
    Field(discriminator="type"),
]


class ListProjectsInput(StrictInput):
    page: int = Field(default=1, ge=1, le=10000)
    page_size: int = Field(default=20, ge=1, le=100)


class TargetInput(StrictInput):
    target: WorkshopTarget


class ListTargetsInput(StrictInput):
    project_id: Identifier
    type: Literal["character", "ui", "video"] | None = None
    page: int = Field(default=1, ge=1, le=10000)
    page_size: int = Field(default=20, ge=1, le=50)


class CreateTargetInput(StrictInput):
    project_id: Identifier
    type: Literal["character", "ui_scheme", "ui_screen", "video"]
    name: str = Field(min_length=1, max_length=120)
    ui_scheme_id: Identifier | None = None
    idempotency_key: IdempotencyKey


DocumentKind = Literal[
    "project_style", "worldview", "gdd", "prd", "interaction",
    "character_spec", "ui_style", "screen_map", "screen_brief", "video_brief", "video_prompt",
]


class ReadDocumentInput(TargetInput):
    kind: DocumentKind


class WriteDocumentInput(ReadDocumentInput):
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    content: str = Field(max_length=200000)
    idempotency_key: IdempotencyKey


class AcknowledgeFeedbackInput(TargetInput):
    feedback_ids: list[Identifier] = Field(min_length=1, max_length=100)
    idempotency_key: IdempotencyKey


class ListMediaInput(TargetInput):
    page: int = Field(default=1, ge=1, le=10000)
    page_size: int = Field(default=20, ge=1, le=100)


class ReadMediaInput(TargetInput):
    media_id: Identifier


class ImageGenerationParams(StrictInput):
    type: Literal["image"] = "image"
    n: int = Field(default=1, ge=1, le=4)
    size: str | None = Field(default=None, pattern=r"^(?:auto|[1-9][0-9]{1,4}x[1-9][0-9]{1,4})$")
    ratio: str | None = Field(default=None, pattern=r"^(?:auto|[1-9][0-9]?:[1-9][0-9]?)$")
    quality: Literal["auto", "low", "medium", "high"] | None = None
    background: Literal["auto", "opaque", "transparent"] | None = None
    style_variant: str | None = Field(default=None, max_length=120)
    base_version: str | None = Field(default=None, max_length=120, pattern=r"^[A-Za-z0-9_.-]+$")


class VideoGenerationParams(StrictInput):
    type: Literal["video"]
    duration: int = Field(default=5, ge=1, le=60)
    ratio: str = Field(default="16:9", pattern=r"^(?:auto|[1-9][0-9]?:[1-9][0-9]?)$")
    resolution: Literal["480p", "720p", "1080p"] = "720p"
    frame_mode: Literal["auto", "first", "last", "firstlast"] = "auto"
    mode: Literal["std", "pro"] | None = None
    generate_audio: bool | None = None
    watermark: bool | None = None


GenerationParams = Annotated[
    ImageGenerationParams | VideoGenerationParams, Field(discriminator="type")
]


class PrepareGenerationInput(TargetInput):
    target: GenerationTarget
    prompt: str = Field(min_length=1, max_length=40000)
    alias: str = Field(min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=240)
    params: GenerationParams
    media_ids: list[Identifier] = Field(default_factory=list, max_length=12)
    idempotency_key: IdempotencyKey

    @model_validator(mode="after")
    def compatible_kind(self):
        expected = "video" if self.target.type == "video" else "image"
        if self.params.type != expected:
            raise ValueError("target and generation type must match")
        if not self.prompt.strip():
            raise ValueError("prompt must not be empty")
        if len(set(self.media_ids)) != len(self.media_ids):
            raise ValueError("media_ids must be unique")
        return self


class GetGenerationInput(StrictInput):
    request_id: Identifier


class WithdrawGenerationInput(GetGenerationInput):
    expected_revision: int = Field(ge=1)


class ApproveGenerationInput(StrictInput):
    expected_revision: int = Field(ge=1)


TOOL_INPUT_MODELS: dict[str, type[BaseModel]] = {
    "list-projects": ListProjectsInput,
    "list-targets": ListTargetsInput,
    "get-context": TargetInput,
    "list-models": TargetInput,
    "create-target": CreateTargetInput,
    "read-document": ReadDocumentInput,
    "write-document": WriteDocumentInput,
    "acknowledge-feedback": AcknowledgeFeedbackInput,
    "list-media": ListMediaInput,
    "read-media": ReadMediaInput,
    "prepare-generation": PrepareGenerationInput,
    "get-generation": GetGenerationInput,
    "withdraw-generation": WithdrawGenerationInput,
}
