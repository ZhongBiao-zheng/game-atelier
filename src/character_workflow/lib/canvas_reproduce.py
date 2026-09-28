"""画布复刻：把一条生成资产展开成「参考输入节点 + 生成配置节点 + 连线」，不自动 Run。

浏览器不能新建媒体版本（`save_canvas_document` 只放行手动文本版本），所以参考媒体由服务端
在一次画布锁内拷进 uploads/、登记版本、建节点与连线。配方里的模型由前端匹配本机 key 后传入，
匹配不到传 null：配置节点模型位留空，画布现有的「先选模型」阻断生效。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from pathlib import Path

from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.canvas_library import _content_node
from character_workflow.lib.canvas_projects import (
    _display_image_dimensions,
    _document_path,
    _now,
    _project_path,
    _read_canvas_document_unlocked,
    _recover_canvas_transactions_unlocked,
    canvas_project_dir,
    canvas_project_lock_path,
    read_canvas_project,
)
from character_workflow.lib.creation_assets import (
    CreationAssetStateError,
    creation_asset_input_path,
    get_creation_asset,
    mark_creation_asset_used,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.media_probe import mp4_track_dimensions
from character_workflow.lib.schemas import (
    CANVAS_DRAFT_PARAM_FIELDS,
    MEDIA_SUFFIXES,
    CanvasConfigNode,
    CanvasConfigNodeData,
    CanvasCreationAssetSnapshotOrigin,
    CanvasDocument,
    CanvasGenerationDraft,
    CanvasInputConnection,
    CanvasMediaVersion,
    CanvasPoint,
    CanvasReproduceResponse,
    GenerationRecipe,
    JobParams,
    RecipeInput,
)

_FRAME_SLOTS: dict[str, tuple[str, ...]] = {
    "first": ("first_frame",),
    "last": ("last_frame",),
    "firstlast": ("first_frame", "last_frame"),
}
_SKIPPED_ROLE_LABELS = {
    "mask": "蒙版",
    "mj_sref": "Midjourney 风格参考",
    "mj_cref": "Midjourney 角色参考",
    "mj_oref": "Midjourney 全能参考",
}
_MODE_LABELS = {"image": "图片", "video": "视频"}

# 与前端 canvasEditorModel 的节点尺寸规则保持一致，只用于排布，不写进节点。
_NODE_WIDTH = 320.0
_NODE_MIN_HEIGHT = 150.0
_DEFAULT_NODE_HEIGHT = 176.0
_NODE_GAP = 48.0
_COLUMN_GAP = 96.0


@dataclass(frozen=True)
class _PreparedInput:
    row: RecipeInput
    body: bytes


def _prepare_inputs(asset_id: str, recipe: GenerationRecipe) -> tuple[list[_PreparedInput], list[str]]:
    """带上 role == reference 的参考；其余按角色汇总成 warnings。首尾帧模式只接图片、按槽数截断。"""
    references = [row for row in recipe.inputs if row.role == "reference"]
    warnings = []
    for role, label in _SKIPPED_ROLE_LABELS.items():
        count = sum(1 for row in recipe.inputs if row.role == role)
        if count:
            warnings.append(f"没有带上{label}（{count} 份）")
    slots = _frame_slots(recipe)
    if slots:
        images = [row for row in references if row.kind == "image"]
        kept = images[:len(slots)]
        dropped = len(references) - len(kept)
        if dropped:
            warnings.append(f"首尾帧模式只接 {len(slots)} 张图片，另 {dropped} 份参考没有带上")
        references = kept
    prepared = []
    for row in references:
        try:
            path, _mime = creation_asset_input_path(asset_id, row.order)
        except FileNotFoundError as error:
            raise CreationAssetStateError("生成资产的参考文件缺失") from error
        prepared.append(_PreparedInput(row=row, body=path.read_bytes()))
    return prepared, warnings


def _frame_slots(recipe: GenerationRecipe) -> tuple[str, ...]:
    if recipe.mode != "video":
        return ()
    return _FRAME_SLOTS.get(str(recipe.params.get("frame_mode") or ""), ())


def _media_dimensions(kind: str, body: bytes) -> tuple[int | None, int | None]:
    if kind == "image":
        return _display_image_dimensions(body)
    if kind == "video":
        dimensions = mp4_track_dimensions(body)
        if dimensions:
            return dimensions
    return None, None


def _rendered_size(width: int | None, height: int | None) -> tuple[float, float]:
    """画布渲染时按版本比例锁定的节点尺寸（canvasNodeRenderedSize 的默认宽度分支）。"""
    if not width or not height:
        return _NODE_WIDTH, _DEFAULT_NODE_HEIGHT
    ratio = width / height
    rendered_height = _NODE_WIDTH / ratio
    if rendered_height < _NODE_MIN_HEIGHT:
        return _NODE_MIN_HEIGHT * ratio, _NODE_MIN_HEIGHT
    return _NODE_WIDTH, rendered_height


def _draft(recipe: GenerationRecipe, title: str, model: str | None, alias: str | None,
           has_inputs: bool, timestamp: str) -> CanvasGenerationDraft:
    allowed = CANVAS_DRAFT_PARAM_FIELDS[recipe.mode]
    params = {key: value for key, value in recipe.params.items() if key in allowed}
    params["creation_asset_source_title"] = title
    if recipe.mode == "video" and has_inputs and not _frame_slots(recipe):
        # 画布视频的全能参考正式写法是 frame_mode="auto"；缺省时前端会按首尾帧处理并拦住 Run。
        params["frame_mode"] = "auto"
    return CanvasGenerationDraft(
        mode=recipe.mode,
        # 画布 Run 补的编号前缀已由 generation_recipe 建配方时精确去掉，这里原样写入。
        prompt=recipe.final_prompt,
        input_policy="all_connected",
        model=model or "",
        alias=alias,
        params=JobParams(**params),
        updated_at=timestamp,
    )


def _commit(project_id: str, document: CanvasDocument, writes: list[tuple[Path, bytes]],
            timestamp: str) -> None:
    """先落全部参考字节与 project.json，canvas.json 最后写（命令提交点）；中途失败清掉已写字节。"""
    project = read_canvas_project(project_id).model_copy(update={"updated_at": timestamp})
    document.sync_layer_materials()
    try:
        for target, body in writes:
            atomic_write_bytes(target, body)
        atomic_write_json(_project_path(project_id), project.model_dump(mode="json"))
        atomic_write_json(_document_path(project_id), document.model_dump(mode="json"))
    except BaseException:
        for target, _body in writes:
            target.unlink(missing_ok=True)
        raise


def reproduce_generation_asset_into_canvas(
    *,
    project_id: str,
    asset_id: str,
    position: CanvasPoint,
    alias: str | None,
    model: str | None,
    document_revision: int,
) -> CanvasReproduceResponse:
    """position 是新建节点整体的左上角：参考节点一列在左，配置节点在右，与第一个参考顶对齐。"""
    asset = get_creation_asset(asset_id)
    if asset.content.kind != "generation":
        raise ValueError("只有生成资产能复刻到画布")
    recipe = asset.content.snapshot
    prepared, warnings = _prepare_inputs(asset_id, recipe)
    slots = _frame_slots(recipe)

    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != document_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")

        timestamp = _now()
        origin = CanvasCreationAssetSnapshotOrigin(kind="creation_asset_snapshot", title=asset.title)
        versions = []
        writes: list[tuple[Path, bytes]] = []
        for item in prepared:
            relative = Path("uploads") / (
                f"creation-asset-{secrets.token_hex(12)}{MEDIA_SUFFIXES[item.row.mime_type]}"
            )
            width, height = _media_dimensions(item.row.kind, item.body)
            versions.append(CanvasMediaVersion(
                version_id=f"version-{secrets.token_hex(12)}",
                created_at=timestamp,
                sha256=item.row.sha256,
                origin=origin,
                kind=item.row.kind,
                path=relative.as_posix(),
                mime_type=item.row.mime_type,
                bytes=len(item.body),
                width=width,
                height=height,
            ))
            writes.append((canvas_project_dir(project_id) / relative, item.body))

        sizes = [_rendered_size(version.width, version.height) for version in versions]
        column_width = max((width for width, _height in sizes), default=0.0)
        input_nodes = []
        y = position.y
        for index, (version, (_width, height)) in enumerate(zip(versions, sizes, strict=True)):
            input_nodes.append(_content_node(
                version.version_id,
                f"参考 {index + 1}",
                CanvasPoint(x=position.x, y=y),
                version.kind,
            ))
            y += height + _NODE_GAP

        config_x = position.x + column_width + _COLUMN_GAP if input_nodes else position.x
        config = CanvasConfigNode(
            id=f"config-{secrets.token_hex(8)}",
            type="config",
            title=f"{_MODE_LABELS[recipe.mode]}生成",
            position=CanvasPoint(x=config_x, y=position.y),
            z_index=0,
            data=CanvasConfigNodeData(draft=_draft(
                recipe, asset.title, model, alias, bool(input_nodes), timestamp,
            )),
        )
        connections = [
            CanvasInputConnection(
                id=f"connection-{secrets.token_hex(10)}",
                role="input",
                source_node_id=node.id,
                target_node_id=config.id,
                slot=slots[index] if slots else None,
            )
            for index, node in enumerate(input_nodes)
        ]
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": [*current.nodes, *input_nodes, config],
            "connections": [*current.connections, *connections],
            "content_versions": {
                **current.content_versions,
                **{version.version_id: version for version in versions},
            },
        })
        # model_copy 不跑校验：落盘前按 CanvasDocument 整体校验一次，坏文档不能写进 canvas.json。
        document = CanvasDocument.model_validate(updated.model_dump(mode="json"))
        _commit(project_id, document, writes, timestamp)

    # 画布已经落盘：资产若在此期间被删，不记使用就是，别把已成功的复刻报成 404。
    try:
        mark_creation_asset_used(asset_id, project_id)
    except KeyError:
        pass
    return CanvasReproduceResponse.model_validate(
        {**document.model_dump(mode="json"), "warnings": warnings}
    )
