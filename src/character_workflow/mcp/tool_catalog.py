"""Canvas MCP 注册元数据；不依赖 MCP SDK，供本地管理页面读取。"""
from dataclasses import dataclass

from character_workflow.lib.canvas_agent_schema import CANVAS_TOOL_INPUT_MODELS, StrictInput


_DESCRIPTIONS = {
    "canvas-list-projects": "List canvas projects this grant may operate.",
    "canvas-get-document": "Read a canvas: nodes, text, drafts, connections, media versions and revision.",
    "canvas-list-models": "List configured image/video models usable in canvas drafts, without credentials.",
    "canvas-apply-changes": (
        "Apply a typed change set (add/edit text, set drafts, connect, move, remove) at the "
        "expected revision. Never touches generated versions or derivation edges."
    ),
    "canvas-import-media": "Copy one local media file into the canvas as an immutable version plus node.",
    "canvas-run": "Start a generation run on a surface node. Paid; requires canvas_generate.",
    "canvas-get-run": "Read a run's status, candidates and output version ids; never retries.",
    "canvas-read-media": "Read a bounded preview/metadata of one media version in this canvas.",
}
_READ_ONLY = frozenset({
    "canvas-list-projects", "canvas-get-document", "canvas-list-models", "canvas-get-run",
    "canvas-read-media",
})


@dataclass(frozen=True)
class ToolDefinition:
    operation: str
    input_model: type[StrictInput]
    description: str
    read_only: bool
    billable: bool

    @property
    def name(self) -> str:
        return self.operation.replace("-", "_")


TOOL_DEFINITIONS = tuple(
    ToolDefinition(
        operation=f"canvas-{name}", input_model=model,
        description=_DESCRIPTIONS[f"canvas-{name}"],
        read_only=f"canvas-{name}" in _READ_ONLY,
        billable=name == "run",
    )
    for name, model in CANVAS_TOOL_INPUT_MODELS.items()
)
ALL_TOOL_INPUT_MODELS = {tool.operation: tool.input_model for tool in TOOL_DEFINITIONS}
