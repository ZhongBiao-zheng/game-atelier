"""插件管理接口：列表、启停、包内文件（ADR-0037）。只挂本机服务，不上局域网网关。"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import plugin_grants, plugin_registry, plugin_server
from character_workflow.lib.plugin_registry import PluginError

router = APIRouter(prefix="/api/plugins")
grants_router = APIRouter(prefix="/api/canvas/projects/{project_id}/plugin-grants")


def _http(error: PluginError) -> HTTPException:
    return HTTPException(error.status, {"message": error.message, "code": error.code})


def _listing() -> dict:
    return {"app_version": plugin_registry.app_version(), "plugins": plugin_registry.list_plugins()}


@router.get("")
def list_plugins() -> dict:
    return _listing()


@router.post("/{plugin_id}/enable")
def enable_plugin(plugin_id: str) -> dict:
    try:
        plugin_registry.set_enabled(plugin_id, True)
    except PluginError as error:
        raise _http(error) from None
    return _listing()


@router.post("/{plugin_id}/disable")
def disable_plugin(plugin_id: str) -> dict:
    try:
        plugin_registry.set_enabled(plugin_id, False)
    except PluginError as error:
        raise _http(error) from None
    # 停用即卸载：服务端模块不留在进程里，下次启用重新加载。
    plugin_server.unload(plugin_id)
    return _listing()


@router.get("/{plugin_id}/package/{file:path}")
def package_file(plugin_id: str, file: str) -> FileResponse:
    try:
        path = plugin_registry.package_file(plugin_id, file)
    except PluginError as error:
        raise _http(error) from None
    # 宿主拿到后要按清单核对 SHA-256 再放进沙箱，不能让浏览器按 MIME 猜类型。
    return FileResponse(path, media_type="application/octet-stream",
                        headers={"X-Content-Type-Options": "nosniff"})


def _grants(call, *args) -> dict:
    try:
        return {"grants": call(*args)}
    except PluginError as error:
        raise _http(error) from None


@grants_router.get("")
def list_grants(project_id: str) -> dict:
    return _grants(plugin_grants.active_grants, project_id)


@grants_router.put("/{plugin_id}")
def grant_plugin(project_id: str, plugin_id: str) -> dict:
    return _grants(plugin_grants.grant, project_id, plugin_id)


@grants_router.delete("/{plugin_id}")
def revoke_plugin(project_id: str, plugin_id: str) -> dict:
    return _grants(plugin_grants.revoke, project_id, plugin_id)


class PluginCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(min_length=1, max_length=160)
    node_id: str = Field(min_length=1, max_length=120)
    inputs: list[str] = Field(default_factory=list, max_length=64)
    params: dict = Field(default_factory=dict)


@router.post("/{plugin_id}/routes/{route:path}")
def call_plugin_route(plugin_id: str, route: str, body: PluginCall) -> dict:
    """插件界面经宿主调用它自己声明的服务端路由。同步处理函数由框架放进线程池执行。"""
    try:
        result, _created = plugin_server.call(
            plugin_id, "POST", "/" + route, project_id=body.project_id, origin="surface",
            params=body.params, node_id=body.node_id, input_version_ids=body.inputs,
        )
    except PluginError as error:
        raise _http(error) from None
    return {"result": result}
