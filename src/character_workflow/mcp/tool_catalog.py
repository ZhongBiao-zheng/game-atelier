"""Canvas MCP 注册元数据；不依赖 MCP SDK，供本地管理页面读取。"""
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import Field

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
    "canvas-search-library": "Find approved image references in the current project by category.",
    "canvas-search-team": "Search image references in team libraries mounted on this canvas.",
    "canvas-read-spec": "Read the project and mounted team specifications for a category.",
    "canvas-read-media": "Read a bounded preview/metadata of one media version in this canvas.",
}
_READ_ONLY = frozenset({
    "canvas-list-projects", "canvas-get-document", "canvas-list-models", "canvas-get-run",
    "canvas-search-library", "canvas-search-team", "canvas-read-spec", "canvas-read-media",
})


# PS 联动插件的 Agent 工具（ADR-0043）：只对白名单插件开放，这里静态登记，列工具时按服务端此刻的可用情况过滤。
class PsProjectInput(StrictInput):
    project_id: str = Field(min_length=1, max_length=160)


class PsImportInput(PsProjectInput):
    scope: Literal["merged", "layer"] = "merged"


class PsPlaceInput(PsProjectInput):
    node_id: str = Field(min_length=1, max_length=120)


class PsPreviewInput(PsProjectInput):
    document_id: int = Field(default=0, ge=0)


class PsExecuteInput(PsProjectInput):
    code: str = Field(min_length=1, max_length=3600)
    document_id: int = Field(default=0, ge=0)


PS_TOOLS = {
    "inspect": (PsProjectInput, True, "Read local Photoshop: version, open documents (id, name, size), the active "
                "document and its layers. Errors if Photoshop is not running; never launches it. Call first."),
    "import": (PsImportInput, False, "Bring the Photoshop selection (or whole document) into the canvas as an image "
               "node and remember where it came from. scope=merged takes visible pixels, layer the current layer."),
    "place": (PsPlaceInput, False, "Place a canvas image node into Photoshop as a smart object layer; images that "
              "came from Photoshop (or were generated from one) go back to their document and position."),
    "preview": (PsPreviewInput, True, "Export a preview image (long edge <= 1600) of a Photoshop document; never "
                "modifies it. Use to check edits."),
    "execute": (PsExecuteInput, False, "Run an ExtendScript (ES3) function body in local Photoshop and return plain "
                "JSON. Only listed when the user turned on Agent scripts in Atelier settings; every run is logged. "
                "Inspect first; save copies instead of overwriting; failures do not roll back."),
}


# 自定义接口的接入说明与干跑校验（ADR-0036，第 5 批 5-6B）：有效的本机 Agent 会话即可调用，不挂项目。
# 只读：不写盘、不发出站请求、不读已有模板与密钥；保存与绑定仍只在本机设置页。
class ProtocolManualInput(StrictInput):
    pass


class ProtocolValidateInput(StrictInput):
    document: dict[str, Any]


PROTOCOL_TOOLS = {
    "manual": (ProtocolManualInput, "Read the Atelier custom interface manual (Markdown): when a template is "
               "needed, the template spec (version 1), submit/failure/billing rules, self-test and safety. "
               "Read it before writing a template for a model vendor."),
    "validate": (ProtocolValidateInput, "Dry-run a custom interface template (JSON object, <= 200 KB): returns "
                 "{valid, issues, declared, preview}. Never saves, never sends requests, never reads stored "
                 "templates or keys. Fields whose names look like credentials (Authorization, api_key, ...) are left "
                 "out of the preview and listed in hidden_fields. Fix issues until valid, then give the JSON to "
                 "the user to paste and save in Atelier settings."),
}


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
) + tuple(
    ToolDefinition(operation=f"ps-{name}", input_model=model, description=description,
                   read_only=read_only, billable=False)
    for name, (model, read_only, description) in PS_TOOLS.items()
) + tuple(
    ToolDefinition(operation=f"atelier-protocol-{name}", input_model=model, description=description,
                   read_only=True, billable=False)
    for name, (model, description) in PROTOCOL_TOOLS.items()
)
ALL_TOOL_INPUT_MODELS = {tool.operation: tool.input_model for tool in TOOL_DEFINITIONS}
