"""插件清单与包锁文件的 schema（ADR-0012 / ADR-0037）。

与 `web/src/schema/plugins.ts` 手工同步；改一边必须改另一边。
"""
from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

PLUGIN_ID_PATTERN = r"^[a-z][a-z0-9-]{1,39}$"
_SEMVER = r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
_NAME = r"^[a-z][a-z0-9_]{0,39}$"
_ROUTE_PATH = r"^/[a-z0-9][a-z0-9/_-]{0,79}$"
_FILE_PATH = r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$"
_SHA256 = r"^[0-9a-f]{64}$"

PluginId = Annotated[str, StringConstraints(pattern=PLUGIN_ID_PATTERN)]
Semver = Annotated[str, StringConstraints(pattern=_SEMVER)]
Sha256 = Annotated[str, StringConstraints(pattern=_SHA256)]
IconName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,39}$")]
Modality = Literal["text", "image", "video", "audio"]

# 当前宿主实现的 capability。清单里出现其他值时插件判为「需要更高版本」，不是清单无效。
SUPPORTED_CAPABILITIES = frozenset({
    "node.read_self", "node.write_self", "resource.read_inputs", "resource.create",
    "storage.project", "server.call", "generation.draft",
})
SUPPORTED_SDK_VERSIONS = frozenset({"1"})


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PluginPublisher(_Model):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{1,39}$")]
    name: str = Field(min_length=1, max_length=80)


class PluginAppVersion(_Model):
    min: Semver
    max: Semver | None = None


class PluginUi(_Model):
    entry: Literal["ui/index.html"]


class PluginSize(_Model):
    width: int = Field(ge=120, le=2000)
    height: int = Field(ge=80, le=2000)


class PluginNodeContribution(_Model):
    type: Annotated[str, StringConstraints(pattern=_NAME)]
    title: str = Field(min_length=1, max_length=40)
    icon: IconName
    default_size: PluginSize
    min_size: PluginSize | None = None
    payload_schema_version: int = Field(ge=1)
    input_modalities: list[Modality] = Field(default_factory=list, max_length=4)
    max_inputs: int | None = Field(default=None, ge=1, le=64)
    surfaces: list[Literal["node", "panel"]] = Field(min_length=1, max_length=2)
    # 连进来的是结果组封面时，按组内顺序把封面与成员都交给插件（一条连线 = 整组）。
    expand_result_stack: bool = False

    @model_validator(mode="after")
    def _stack_needs_images(self) -> "PluginNodeContribution":
        if self.expand_result_stack and "image" not in self.input_modalities:
            raise ValueError("expand_result_stack needs image in input_modalities")
        return self


class PluginCreateNodeAction(_Model):
    kind: Literal["create_node"]
    node_type: Annotated[str, StringConstraints(pattern=_NAME)]
    open_panel: bool = False


class PluginOpenPanelAction(_Model):
    kind: Literal["open_panel"]
    panel: Annotated[str, StringConstraints(pattern=_NAME)]


class PluginMediaAction(_Model):
    """图片 / 视频节点工具栏「更多」或文本节点工具栏里的一项；按钮由宿主按清单画，点击前不运行插件代码。"""

    id: Annotated[str, StringConstraints(pattern=_NAME)]
    label: str = Field(min_length=1, max_length=20)
    icon: IconName
    action: Annotated[PluginCreateNodeAction | PluginOpenPanelAction, Field(discriminator="kind")]


class PluginServerRoute(_Model):
    # 界面与 Agent 都以 JSON 请求体调用，只有 POST。
    method: Literal["POST"]
    path: Annotated[str, StringConstraints(pattern=_ROUTE_PATH)]
    access: Literal["read", "edit"]
    long_running: bool = False


class PluginServerContribution(_Model):
    module: Literal["server"]
    routes: list[PluginServerRoute] = Field(min_length=1, max_length=64)


class PluginAgentTool(_Model):
    name: Annotated[str, StringConstraints(pattern=_NAME)]
    description: str = Field(min_length=1, max_length=400)
    parameters: dict[str, Any]
    read_only: bool
    route: Annotated[str, StringConstraints(pattern=_ROUTE_PATH)]


class PluginContributes(_Model):
    nodes: list[PluginNodeContribution] = Field(default_factory=list, max_length=32)
    image_actions: list[PluginMediaAction] = Field(default_factory=list, max_length=16)
    video_actions: list[PluginMediaAction] = Field(default_factory=list, max_length=16)
    text_actions: list[PluginMediaAction] = Field(default_factory=list, max_length=16)
    server: PluginServerContribution | None = None
    agent_tools: list[PluginAgentTool] = Field(default_factory=list, max_length=32)


class PluginAsset(_Model):
    id: Annotated[str, StringConstraints(pattern=_NAME)]
    title: str = Field(min_length=1, max_length=80)
    urls: list[Annotated[str, StringConstraints(pattern=r"^https://", max_length=500)]] = Field(
        min_length=1, max_length=4)
    bytes: int = Field(gt=0)
    sha256: Sha256
    required: bool = True


class PluginManifest(_Model):
    manifest_version: Literal[1]
    id: PluginId
    name: str = Field(min_length=1, max_length=40)
    version: Semver
    description: str = Field(min_length=1, max_length=80)
    icon: IconName
    publisher: PluginPublisher
    sdk_version: Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]*$")]
    app_version: PluginAppVersion
    # sandbox：界面在沙箱 iframe 里（ADR-0012）。host：界面是宿主代码、按需加载（ADR-0039）；
    # 清单自报不算数，只有宿主白名单里的随应用发布插件可以是 host（plugin_registry.HOST_PLUGIN_IDS）。
    runtime: Literal["sandbox", "host"] = "sandbox"
    ui: PluginUi | None = None
    capabilities: list[Annotated[str, StringConstraints(pattern=r"^[a-z]+\.[a-z_]+$")]] = Field(
        default_factory=list, max_length=32)
    contributes: PluginContributes = Field(default_factory=PluginContributes)
    assets: list[PluginAsset] = Field(default_factory=list, max_length=16)
    state_schema_version: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def _cross_references(self) -> "PluginManifest":
        contributes = self.contributes
        node_types = [node.type for node in contributes.nodes]
        if len(set(node_types)) != len(node_types):
            raise ValueError("plugin node types must be unique")
        nodes = {node.type: node for node in contributes.nodes}
        host = self.runtime == "host"
        for kind, actions in (("image", contributes.image_actions), ("video", contributes.video_actions),
                              ("text", contributes.text_actions)):
            action_ids = [action.id for action in actions]
            if len(set(action_ids)) != len(action_ids):
                raise ValueError(f"plugin {kind} action ids must be unique")
            for action in actions:
                if action.action.kind != "create_node":
                    continue
                target = nodes.get(action.action.node_type)
                if target is None:
                    raise ValueError(f"{kind} action {action.id} targets an undeclared node type")
                # create_node 会从这个素材连一条输入线过去，目标节点必须收这种素材。
                # 宿主插件不连线：来源节点交给插件代码处理（分镜把剧本来源记进 payload）。
                if not host and kind not in target.input_modalities:
                    raise ValueError(f"{kind} action {action.id} targets a node that does not accept {kind}")
        declared = contributes.server.routes if contributes.server else []
        routes = {(route.method, route.path) for route in declared}
        if len(routes) != len(declared):
            raise ValueError("plugin server routes must be unique")
        tool_names = [tool.name for tool in contributes.agent_tools]
        if len(set(tool_names)) != len(tool_names):
            raise ValueError("plugin agent tool names must be unique")
        for tool in contributes.agent_tools:
            if ("POST", tool.route) not in routes:
                raise ValueError(f"agent tool {tool.name} must point at a declared POST route")
        has_surface = contributes.nodes or contributes.image_actions or contributes.video_actions \
            or contributes.text_actions
        if host:
            if self.ui is not None or self.capabilities or contributes.agent_tools:
                raise ValueError("host plugin must not declare ui, capabilities or agent tools")
        elif has_surface and self.ui is None:
            raise ValueError("plugin with node or action contributions must declare ui")
        return self


class PluginPackageFile(_Model):
    path: Annotated[str, StringConstraints(pattern=_FILE_PATH)]
    sha256: Sha256
    bytes: int = Field(ge=0)

    @model_validator(mode="after")
    def _no_traversal(self) -> "PluginPackageFile":
        if ".." in self.path.split("/") or "//" in self.path:
            raise ValueError("plugin package file path must stay inside the package")
        return self


class PluginPackageLock(PluginManifest):
    """构建产物 `package/manifest.lock.json`：源清单 + 文件摘要 + 包摘要。"""

    files: list[PluginPackageFile] = Field(max_length=1000)
    digest: Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]
    source: Literal["bundled"]

    @model_validator(mode="after")
    def _package_consistency(self) -> "PluginPackageLock":
        paths = [item.path for item in self.files]
        if len(set(paths)) != len(paths):
            raise ValueError("plugin package files must be unique")
        if self.ui is not None and self.ui.entry not in paths:
            raise ValueError("plugin ui entry is missing from package files")
        return self


def package_digest(lock: dict[str, Any]) -> str:
    """包摘要 = 去掉 `digest` 后的锁文件按键排序、无空白序列化的 SHA-256。

    构建脚本 `web/scripts/build-plugins.mjs` 用同一规则计算，两边必须一致。
    """
    body = {key: value for key, value in lock.items() if key != "digest"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def parse_semver(value: str) -> tuple[int, int, int]:
    major, minor, patch = value.split(".")
    return int(major), int(minor), int(patch)
