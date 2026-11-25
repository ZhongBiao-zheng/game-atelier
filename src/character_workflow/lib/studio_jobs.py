"""Studio standalone job helpers. namespace='studio', 输出落到 <data_root>/studio/<job_id>/."""
from __future__ import annotations

import uuid
from pathlib import Path

from character_workflow.lib.data_root import resolve_data_root


def studio_root() -> Path:
    return resolve_data_root() / "studio"


def studio_output_dir(job_id: str) -> Path:
    """Studio job 写盘路径. 与 characters/<id>/<slot>/ 物理隔离."""
    d = studio_root() / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


# 新节点放在画布现有内容右侧，留一段空隙；没有尺寸的节点按默认卡宽估算。
_CANVAS_GAP = 80
_CANVAS_DEFAULT_NODE_WIDTH = 320
_CANVAS_SAVE_ATTEMPTS = 3
_CANVAS_TITLE_LENGTH = 40


def add_job_output_to_canvas(job_id: str, output_index: int, project_id: str) -> dict:
    """创作台结果卡「加入画布」：把一张图 / 一条视频作为新节点放进目标画布（D4）。

    不建个人资产；节点标题取提示词开头。返回 {project_id, node_id, revision}。
    结果不存在抛 LookupError，格式或大小不合适抛 ValueError，画布连续被改抛 RuntimeError。"""
    from character_workflow.lib.canvas_projects import (
        IMAGE_UPLOAD_EXTS, VIDEO_UPLOAD_EXTS, read_canvas_document, save_canvas_upload, upload_max_bytes,
    )
    from character_workflow.lib.jobs import read_job
    from character_workflow.lib.schemas import (
        CanvasImageNode, CanvasMediaNodeData, CanvasPoint, CanvasVideoNode,
    )

    job = read_job(job_id)
    if job.namespace != "studio":
        raise ValueError("只能加入创作台的生成结果")
    if not 0 <= output_index < len(job.output_paths):
        raise LookupError("这张结果不存在")
    raw = Path(job.output_paths[output_index])
    source = raw if raw.is_absolute() else resolve_data_root() / raw
    if not source.is_file():
        raise LookupError("结果文件已不在磁盘上")
    ext = source.suffix.lower()
    if ext in IMAGE_UPLOAD_EXTS:
        kind = "image"
    elif ext in VIDEO_UPLOAD_EXTS:
        kind = "video"
    else:
        raise ValueError("画布不支持这种格式")
    if source.stat().st_size > upload_max_bytes(ext):
        raise ValueError("文件超过画布导入大小上限")
    body = source.read_bytes()
    title = " ".join(job.prompt.split())[:_CANVAS_TITLE_LENGTH] or ("图片" if kind == "image" else "视频")
    node_id = f"studio-{uuid.uuid4().hex[:12]}"
    node_type = CanvasImageNode if kind == "image" else CanvasVideoNode
    for _ in range(_CANVAS_SAVE_ATTEMPTS):
        document = read_canvas_document(project_id)
        right = max(
            (node.position.x + (node.size.width if node.size else _CANVAS_DEFAULT_NODE_WIDTH)
             for node in document.nodes),
            default=-_CANVAS_GAP,
        )
        top = min((node.position.y for node in document.nodes), default=0)
        position = CanvasPoint(x=right + _CANVAS_GAP, y=top)

        def factory(version, position=position):
            return node_type(id=node_id, title=title, position=position, type=kind,
                             data=CanvasMediaNodeData(current_version_id=version.version_id))
        try:
            _, saved, _ = save_canvas_upload(
                project_id, source.name, ext, body, kind, document.revision, node_factory=factory,
            )
        except RuntimeError as error:
            if str(error).startswith("revision_conflict:"):
                continue
            raise
        return {"project_id": project_id, "node_id": node_id, "revision": saved.revision}
    raise RuntimeError("画布正在被修改，请稍后重试")
