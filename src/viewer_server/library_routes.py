"""Local asset library. HTTP callers identify sources by stable IDs, never by paths."""
from __future__ import annotations

import mimetypes
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Literal
from zipfile import ZipFile

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import library, slug
from character_workflow.lib.canvas_projects import (
    _ACCEPTED_MIMES, _sniff_media_mime, read_canvas_document, resolve_canvas_media, upload_max_bytes,
)
from character_workflow.lib.team_library_share import _media_filename
from viewer_server.history_routes import OutputRef, _lookup
from viewer_server.routes import _read_gallery_hidden_state

router = APIRouter(prefix="/api/library")
Key = Annotated[str, Field(pattern=r"^(?:favorites|(?:itm|sbj|fld)_[a-f0-9]{32})$")]


class Folder(BaseModel):
    name: str
    parent_id: Key | None = None


class Subject(BaseModel):
    name: str
    description: str = Field(default="", max_length=40000)
    handle: str | None = None


class Edit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    title: str | None = None
    handle: str | None = None
    description: str | None = Field(default=None, max_length=40000)
    parent_id: Key | None = None
    cover_item_id: Key | None = None


class Target(BaseModel):
    target: Key | None = None


class CanvasRef(BaseModel):
    project_id: str
    version_id: str


@contextmanager
def errors():
    try:
        yield
    except (FileNotFoundError, KeyError) as e:
        raise HTTPException(404, "找不到素材或原位置") from e
    except (ValueError, PermissionError) as e:
        raise HTTPException(422, str(e)) from e


@router.get("")
def listing():
    return library.catalog()


@router.get("/handle")
def handle(name: str):
    with errors():
        return {"handle": slug.dedupe(slug.generate(name), {s["handle"] for s in library.catalog()["subjects"]})}


@router.post("/folders")
def create_folder(body: Folder):
    with errors():
        return library.folder(**body.model_dump())


@router.post("/subjects")
def create_subject(body: Subject):
    with errors():
        return library.subject(**body.model_dump())


@router.post("/{owner}/upload")
def upload(owner: Key, file: UploadFile):
    title = Path((file.filename or "素材").replace("\\", "/")).name
    ext = Path(title).suffix.lower()
    limit = upload_max_bytes(ext)
    body = file.file.read(limit + 1)
    if len(body) > limit:
        raise HTTPException(413, "文件过大")
    if ext in {".md", ".txt"}:
        kind = "text"
    else:
        mime = _sniff_media_mime(body)
        if not mime or mime not in _ACCEPTED_MIMES.get(ext, set()) | ({"image/gif"} if ext == ".gif" else set()):
            raise HTTPException(422, "不支持的素材格式")
        kind = mime.split("/")[0]
    with errors():
        return library.insert(owner, title, body, kind, ext, {"kind": "upload"})


@router.post("/{owner}/history")
def from_history(owner: Key, ref: OutputRef):
    with errors():
        job, path = _lookup(ref, *map(set, _read_gallery_hidden_state()))
        return library.insert(owner, path.name, path.read_bytes(), job.kind, path.suffix.lower(),
                              {"kind": "history", **ref.model_dump()})


@router.post("/{owner}/canvas")
def from_canvas(owner: Key, ref: CanvasRef):
    with errors():
        document = read_canvas_document(ref.project_id)
        version = document.content_versions[ref.version_id]
        node = next((n for n in document.nodes if getattr(n.data, "current_version_id", None) == ref.version_id), None)
        title = getattr(node, "title", None) or version.version_id
        source = dict(kind="canvas", canvas_project_id=ref.project_id, version_id=ref.version_id,
                      node_id=node.id if node else None)
        if version.kind == "text":
            return library.insert(owner, title, version.text.encode(), "text", ".md", source)
        path, _ = resolve_canvas_media(ref.project_id, ref.version_id)
        return library.insert(owner, title, path.read_bytes(), version.kind, path.suffix.lower(), source)


@router.patch("/{key}")
def edit(key: Key, body: Edit):
    fields = body.model_dump(exclude_unset=True)
    if any(value is None and field != "parent_id" for field, value in fields.items()):
        raise HTTPException(422, "字段不能为空")
    with errors():
        return library.update(key, fields)


@router.post("/{key}/{action}")
def transfer(key: Key, action: Literal["copy", "move", "favorite"], body: Target):
    with errors():
        if action == "move":
            if not body.target:
                raise ValueError("请选择目标文件夹")
            return library.move(key, body.target)
        return library.duplicate(key, library.FAVORITES if action == "favorite" else body.target)


@router.delete("/{key}")
def delete(key: Key):
    with errors():
        return {"trash_id": library.remove(key)}


@router.get("/{key}/content")
def content(key: Key, download: bool = False):
    with errors():
        item, path = library.media(key)
        name = _filename(item, path) if download else None
        mime = "text/plain; charset=utf-8" if item["kind"] == "text" else mimetypes.guess_type(path)[0]
        return FileResponse(path, filename=name, media_type=mime or "application/octet-stream",
                            headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"})


def _filename(item, path):
    name = _media_filename(item["title"])
    return name if Path(name).suffix else name + path.suffix


@router.post("/download")
def download(keys: Annotated[list[Key], Field(min_length=1)]):
    archive = tempfile.TemporaryFile()
    try:
        with errors(), library.transaction() as tx, ZipFile(archive, "w") as zipped:
            used = set()

            def add(key, prefix=""):
                row = tx.get(key)
                if key.startswith("itm_"):
                    item, path = library.media(key)
                    name = _filename(item, path)
                else:
                    name = _media_filename(row["name"])
                candidate = prefix + name
                index = 1
                while candidate.casefold() in used:
                    index += 1
                    candidate = f"{prefix}{index}-{name}"
                used.add(candidate.casefold())
                if key.startswith("itm_"):
                    zipped.write(path, candidate)
                    return
                zipped.writestr(candidate + "/", b"")
                for item in row["item_ids"]:
                    add(item, candidate + "/")
                for child in library._all("folders"):
                    if child["parent_id"] == key:
                        add(child["id"], candidate + "/")

            for key in dict.fromkeys(keys):
                add(key)
        archive.seek(0)
    except BaseException:
        archive.close()
        raise

    def chunks():
        with archive:
            while chunk := archive.read(256 * 1024):
                yield chunk
    return StreamingResponse(chunks(), media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="library.zip"'})
