"""Host plugin routes. Encoding continues on the host loop after submit returns."""
from anyio import from_thread
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib.plugin_registry import PluginError
from character_workflow.lib.video_encoder import VideoError
from character_workflow.lib.video_operations import Record, Submit
from character_workflow.lib.video_service import service


class Version(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: str = Field(min_length=1, max_length=160)


class Operation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: str = Field(pattern=r"^video-[0-9a-f]{32}$")


def register(api):
    def route(name, schema, action):
        @api.route("POST", "/" + name)
        def call(ctx, params):
            if ctx.origin != "host" or not ctx.project_id:
                raise PluginError("PROJECT_REQUIRED", "请在本机画布项目中使用视频处理", status=403)
            body = schema.model_validate(params)
            try:
                return from_thread.run(action, ctx.project_id, body)
            except (KeyError, FileNotFoundError):
                raise PluginError("NOT_FOUND", "找不到项目中的视频版本或操作", status=404) from None
            except PermissionError:
                raise PluginError("ACCESS_DENIED", "无权读取该素材", status=403) from None
            except VideoError as error:
                status = 409 if error.code == "request_conflict" else 422
                raise PluginError(error.code, str(error), status=status) from None

    async def probe(project, body):
        return await service().probe(project, body.version_id)

    async def submit(project, body):
        return await service().queue.submit(project, body)

    async def get(project, body):
        return await service().queue.get(Record(project, body.operation_id))

    async def cancel(project, body):
        return await service().queue.cancel(Record(project, body.operation_id))

    route("probe", Version, probe)
    route("submit", Submit, submit)
    route("get", Operation, get)
    route("cancel", Operation, cancel)
