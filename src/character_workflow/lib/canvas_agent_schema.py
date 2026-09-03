"""Strict external inputs for the canvas_* MCP tools; the canvas document itself never crosses raw."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from character_workflow.lib.workshop_schema import Identifier, StrictInput

NodeId = Annotated[str, StringConstraints(min_length=1, max_length=120)]
EdgeId = Annotated[str, StringConstraints(min_length=1, max_length=160)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Text = Annotated[str, StringConstraints(max_length=40_000)]


class CanvasListProjectsInput(StrictInput):
    pass


class CanvasProjectInput(StrictInput):
    project_id: Identifier


class CanvasPointInput(StrictInput):
    x: float
    y: float


class AddTextChange(StrictInput):
    op: Literal["add_text"]
    title: Title
    text: Text
    position: CanvasPointInput
    node_id: NodeId | None = None


class AddMediaNodeChange(StrictInput):
    op: Literal["add_media_node"]
    title: Title
    version_id: EdgeId
    position: CanvasPointInput
    node_id: NodeId | None = None


class SetTextChange(StrictInput):
    op: Literal["set_text"]
    node_id: NodeId
    text: Text


class SetDraftChange(StrictInput):
    op: Literal["set_draft"]
    node_id: NodeId
    mode: Literal["text", "image", "video", "audio"]
    prompt: Text
    model: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    alias: Annotated[str, StringConstraints(min_length=1, max_length=120)] | None = None
    input_policy: Literal["all_connected", "mentions_only"] | None = None
    # 只接受标量；服务端再按 CANVAS_DRAFT_PARAM_FIELDS 过滤，路径类字段永远进不来。
    params: dict[str, str | int | float | bool] = Field(default_factory=dict, max_length=40)


class ConnectChange(StrictInput):
    op: Literal["connect"]
    source_node_id: NodeId
    target_node_id: NodeId
    slot: Literal["first_frame", "last_frame"] | None = None


class DisconnectChange(StrictInput):
    op: Literal["disconnect"]
    connection_id: EdgeId


class MoveChange(StrictInput):
    op: Literal["move"]
    node_id: NodeId
    position: CanvasPointInput


class RemoveNodeChange(StrictInput):
    op: Literal["remove_node"]
    node_id: NodeId


CanvasChange = Annotated[
    AddTextChange | AddMediaNodeChange | SetTextChange | SetDraftChange | ConnectChange
    | DisconnectChange | MoveChange | RemoveNodeChange,
    Field(discriminator="op"),
]


class ApplyChangesInput(CanvasProjectInput):
    expected_revision: int = Field(ge=0)
    changes: list[CanvasChange] = Field(min_length=1, max_length=50)


class ImportMediaInput(CanvasProjectInput):
    expected_revision: int = Field(ge=0)
    path: Annotated[str, StringConstraints(min_length=1, max_length=4096)]
    title: Title | None = None
    position: CanvasPointInput | None = None


class RunInput(CanvasProjectInput):
    surface_node_id: NodeId
    expected_revision: int = Field(ge=0)
    requested_count: int = Field(default=1, ge=1, le=4)


class GetRunInput(CanvasProjectInput):
    run_id: EdgeId


class CanvasReadMediaInput(CanvasProjectInput):
    version_id: EdgeId


class CanvasListModelsInput(CanvasProjectInput):
    mode: Literal["image", "video"] = "image"


# 工具名 = "canvas_" + key.replace("-", "_")；HTTP 端点 = /api/canvas-agent/<key>。
CANVAS_TOOL_INPUT_MODELS: dict[str, type[StrictInput]] = {
    "list-projects": CanvasListProjectsInput,
    "get-document": CanvasProjectInput,
    "list-models": CanvasListModelsInput,
    "apply-changes": ApplyChangesInput,
    "import-media": ImportMediaInput,
    "run": RunInput,
    "get-run": GetRunInput,
    "read-media": CanvasReadMediaInput,
}
