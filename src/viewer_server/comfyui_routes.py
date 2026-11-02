"""Local-session-only workflow administration (never mounted on the LAN gateway)."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import comfyui_workflows as workflows
from character_workflow.lib.comfyui_client import ComfyUIClient, ComfyUIUnavailableError
from character_workflow.lib.comfyui_schema import WorkflowInput, local_base_url

router = APIRouter(prefix="/api/comfyui")


class Connection(BaseModel):
    base_url: str = "http://127.0.0.1:8188"


class Inspect(BaseModel):
    api_workflow: dict
    previous_id: str | None = None


class Save(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    source_filename: str = Field(default="", max_length=255)
    api_workflow: dict
    inputs: list[WorkflowInput] = Field(max_length=100)
    identifier: str | None = None
    timeout_seconds: int = Field(default=1800, ge=1, le=86400)


def _call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except ComfyUIUnavailableError as error:
        raise HTTPException(503, str(error)) from error
    except (ValueError, OSError) as error:
        raise HTTPException(422, str(error)) from error


@router.post("/connection")
def connection(body: Connection):
    def check():
        with ComfyUIClient(local_base_url(body.base_url)) as client:
            stats = client.get("/system_stats")
        return {"devices": [{"name": device.get("name", "未知显卡"),
                             "vram_total": device.get("vram_total", 0)}
                            for device in stats.get("devices", [])]}
    return _call(check)


@router.get("/{alias}/workflows")
def listing(alias: str):
    return {"workflows": [item.model_dump() for item in _call(workflows.list_workflows, alias)]}


@router.post("/{alias}/inspect")
def inspect(alias: str, body: Inspect):
    return _call(workflows.inspect_workflow, alias, body.api_workflow, body.previous_id)


@router.post("/{alias}/workflows")
def save(alias: str, body: Save):
    return _call(workflows.save_workflow, alias, **body.model_dump(exclude={"inputs"}),
                 inputs=body.inputs).model_dump()


@router.delete("/{alias}/workflows/{identifier}", status_code=204)
def delete(alias: str, identifier: str):
    _call(workflows.delete_workflow, alias, identifier)
