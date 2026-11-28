"""Local asset library templates."""
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from character_workflow.lib import canvas_templates as templates

router = APIRouter(prefix="/api/library/templates")


class TemplateName(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class SaveTemplate(TemplateName):
    project_id: str
    group_id: str


@contextmanager
def _errors():
    try:
        yield
    except (FileNotFoundError, KeyError):
        raise HTTPException(404, "找不到模板、画布组或其媒体") from None
    except (ValueError, PermissionError) as error:
        raise HTTPException(422, str(error)) from error


@router.get("")
def list_templates():
    return {"items": templates.list_templates()}


@router.post("", status_code=201)
def save_template(body: SaveTemplate):
    with _errors():
        return templates.save_template(body.project_id, body.group_id, body.name)


@router.patch("/{template_id}")
def rename_template(template_id: str, body: TemplateName):
    with _errors():
        return templates.rename_template(template_id, body.name)


@router.post("/{template_id}/duplicate", status_code=201)
def duplicate_template(template_id: str):
    with _errors():
        return templates.duplicate_template(template_id)


@router.delete("/{template_id}")
def delete_template(template_id: str):
    with _errors():
        return {"trash_id": templates.delete_template(template_id)}


@router.get("/{template_id}/cover")
def template_cover(template_id: str):
    with _errors():
        return Response(templates.template_cover(template_id).read_bytes(), media_type="image/webp")
