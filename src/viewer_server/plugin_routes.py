"""插件管理接口：列表、启停、包内文件（ADR-0037）。只挂本机服务，不上局域网网关。"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from character_workflow.lib import plugin_registry
from character_workflow.lib.plugin_registry import PluginError

router = APIRouter(prefix="/api/plugins")


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
