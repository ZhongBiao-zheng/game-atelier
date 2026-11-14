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
    "storage.project", "server.call",
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


class PluginCreateNodeAction(_Model):
    kind: Literal["create_node"]
    node_type: Annotated[str, StringConstraints(pattern=_NAME)]
    open_panel: bool = False


class PluginOpenPanelAction(_Model):
    kind: Literal["open_panel"]
    panel: Annotated[str, StringConstraints(pattern=_NAME)]


class PluginImageAction(_Model):
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
    image_actions: list[PluginImageAction] = Field(default_factory=list, max_length=16)
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
        action_ids = [action.id for action in contributes.image_actions]
        if len(set(action_ids)) != len(action_ids):
            raise ValueError("plugin image action ids must be unique")
        for action in contributes.image_actions:
            if action.action.kind == "create_node" and action.action.node_type not in node_types:
                raise ValueError(f"image action {action.id} targets an undeclared node type")
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
        if (contributes.nodes or contributes.image_actions) and self.ui is None:
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
