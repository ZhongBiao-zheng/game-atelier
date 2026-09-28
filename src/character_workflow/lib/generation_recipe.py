"""配方来源：把一次生成（Studio job 结果 / 画布结果版本）解析成自包含的 RecipeSource。

分享到团队库与「保存为生成资产」共用这一处：成片路径、冻结配方、每份参考的本机路径。
参考路径都过闸——Studio 走 `local_paths.data_root_file`（数据根内、非 .config、.runtime 只认 uploads），
画布走 `resolve_canvas_media`（resolve 后必须在本画布项目的 uploads / derived / outputs 内，
outputs 还须登记在本项目的画布 job 上）。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.canvas_projects import read_canvas_document, resolve_canvas_media
from character_workflow.lib.canvas_runs import canvas_numbering_prefix
from character_workflow.lib.creation_assets import (
    _normalize_tags,
    _required_text,
    create_generation_asset,
    sniff_media_mime,
    store_media_blob,
)
from character_workflow.lib.jobs import read_job
from character_workflow.lib.local_paths import DataRootFileMissing, data_root_file
from character_workflow.lib.schemas import (
    JOB_PARAM_PATH_FIELDS,
    MEDIA_SUFFIXES,
    CanvasDocument,
    CanvasGenerationSnapshot,
    CanvasMediaVersion,
    CreationAsset,
    CreationMediaAssetContent,
    GenerationRecipe,
    Job,
    JobKind,
    JobParams,
    JobStatus,
    RecipeInput,
    RecipeInputRole,
)

# 快照 params 不带的字段：本机路径（参考本体另存）、费用（进 cost_cny）、
# 运行后由 caller / runner 回写的状态、指回本机对象的来源记录。
RECIPE_PARAM_EXCLUDE = frozenset({
    # 本机文件路径
    "reference_images", "reference_videos", "reference_audios", "mask_image",
    "mj_sref", "mj_cref", "mj_oref", "archived_from_path",
    # 费用
    "estimated_cost_cny", "actual_cost_cny",
    # 运行后回写
    "warnings", "requested_size", "actual_size", "provider_task_protocol",
    "provider_task_ids", "layer_decomposition_result", "mj_flags",
    # 本机来源记录
    "creation_asset_source_title", "archived_from_job_id",
})
# 白名单：JobParams 声明过的字段去掉上面的排除项，再放行前端可编辑的 seed。
# JobParams 是 extra="allow"，浏览器能塞任意键（含路径）：未声明的额外键一律不进快照。
RECIPE_PARAM_ALLOW = frozenset(set(JobParams.model_fields) - RECIPE_PARAM_EXCLUDE) | {"seed"}

# 参考在快照里的顺序（order 全局递增）= JOB_PARAM_PATH_FIELDS 的顺序；首尾帧靠 params.frame_mode
# 解释 reference_images 顺序。不含 params 里的 extra 字段 source_image：未声明的键不进快照。
_REF_ROLES: dict[str, RecipeInputRole] = {
    "mask_image": "mask", "mj_sref": "mj_sref", "mj_cref": "mj_cref", "mj_oref": "mj_oref",
}
_JOB_REF_FIELDS: tuple[tuple[str, RecipeInputRole], ...] = tuple(
    (field, _REF_ROLES.get(field, "reference")) for field in JOB_PARAM_PATH_FIELDS
)
_SOURCE_STATUSES = frozenset({JobStatus.DONE, JobStatus.PARTIAL})
_SOURCE_KINDS = frozenset({JobKind.IMAGE, JobKind.VIDEO})
_RECIPE_MODES = frozenset({"image", "video"})
_SUFFIX_MIMES = {suffix: mime for mime, suffix in MEDIA_SUFFIXES.items()} | {".jpeg": "image/jpeg"}
_SNIFF_HEAD_BYTES = 64
_HASH_CHUNK = 1024 * 1024
# 与 CreationAsset.title / tags 的 Field 上限一致：写 blob 之前先挡，别等建目录项时才炸、
# 留下一堆没有目录项引用的 blob。单个标签的长度由 _normalize_tags 管。
_TITLE_MAX_LENGTH = 120
_TAG_MAX_COUNT = 20


@dataclass(frozen=True)
class RecipeSource:
    media_path: Path
    media_filename: str
    recipe: GenerationRecipe
    input_paths: list[Path]  # input_paths[i] ↔ recipe.inputs[i]
    origin_job_id: str | None
    origin_canvas_project_id: str | None


class RecipeSourceError(ValueError):
    """这个来源现在给不出配方：code = "not_shareable" | "source_missing"。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class RecipeSourceNotFound(LookupError):
    """来源 job / 画布项目 / 节点 / 版本不存在（或节点与版本对不上）。"""


# ------------------------------------------------------------------ 通用


def media_mime(path: Path) -> str:
    """按文件头定类型，嗅不出才信后缀：本机 .png 实为 JPEG 的产物很多（Ark 默认出 jpeg），
    按后缀登记会让采用侧的内容校验把整条资产拒掉。"""
    suffix_mime = _SUFFIX_MIMES.get(path.suffix.lower())
    try:
        with path.open("rb") as handle:
            head = handle.read(_SNIFF_HEAD_BYTES)
    except FileNotFoundError as error:
        raise RecipeSourceError("source_missing", f"本机找不到文件：{path.name}") from error
    mime = sniff_media_mime(head, suffix_mime) or suffix_mime
    if mime is None:
        raise RecipeSourceError(
            "not_shareable", f"不支持这种文件格式：{path.suffix or '无扩展名'}"
        )
    if mime not in MEDIA_SUFFIXES:
        raise RecipeSourceError("not_shareable", f"不支持这种文件格式：{mime}")
    return mime


def recipe_params(params: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in params.items() if k in RECIPE_PARAM_ALLOW and v is not None}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(_HASH_CHUNK), b""):
                digest.update(chunk)
    except FileNotFoundError as error:
        raise RecipeSourceError("source_missing", f"本机找不到文件：{path.name}") from error
    return digest.hexdigest()


def _recipe_input(order: int, role: RecipeInputRole, path: Path) -> RecipeInput:
    mime = media_mime(path)
    return RecipeInput(
        order=order, role=role, kind=mime.split("/", 1)[0], sha256=_sha256_file(path),
        mime_type=mime,
    )


def _job_cost(job: Job) -> tuple[float | None, str | None]:
    if job.params.actual_cost_cny is not None:
        return job.params.actual_cost_cny, "actual"
    if job.params.estimated_cost_cny is not None:
        return job.params.estimated_cost_cny, "estimated"
    return None, None


# ------------------------------------------------------------------ job_output


def _shareable_file(value: str) -> Path:
    """job 里登记的参考路径过 `data_root_file` 闸门（浏览器能经 POST /api/prompt 替换 params）。"""
    try:
        return data_root_file(value)
    except DataRootFileMissing as error:
        raise RecipeSourceError("source_missing", str(error)) from error
    except ValueError as error:
        raise RecipeSourceError("not_shareable", f"参考无法打包：{error}") from error


def _read_studio_job(job_id: str) -> Job:
    if Path(job_id).name != job_id or job_id.startswith("."):
        raise RecipeSourceNotFound(job_id)
    try:
        return read_job(job_id)
    except FileNotFoundError as error:
        raise RecipeSourceNotFound(job_id) from error


def _job_output(job: Job, output_index: int) -> Path:
    # R6：只收 Studio、已完成、图片 / 视频的 job。
    if job.namespace != "studio":
        raise RecipeSourceError("not_shareable", "只有 Studio 记录可以分享")
    if job.status not in _SOURCE_STATUSES:
        raise RecipeSourceError("not_shareable", "只有已完成的记录可以分享")
    if job.kind not in _SOURCE_KINDS:
        raise RecipeSourceError("not_shareable", "只有图片与视频结果可以分享")
    if not 0 <= output_index < len(job.output_paths):
        raise RecipeSourceError("not_shareable", "这条记录没有这张结果")
    root = data_root.resolve_data_root().resolve()
    raw = Path(job.output_paths[output_index])
    path = (raw if raw.is_absolute() else root / raw).resolve()
    studio_dir = (root / "studio" / job.job_id).resolve()
    if path.parent != studio_dir:
        raise RecipeSourceError("not_shareable", "Studio 记录的产物路径不在自己的输出目录")
    if not path.is_file():
        raise RecipeSourceError("source_missing", f"本机找不到结果文件：{path.name}")
    return path


def _job_ref_paths(job: Job) -> list[tuple[RecipeInputRole, Path]]:
    refs: list[tuple[RecipeInputRole, Path]] = []
    for field, role in _JOB_REF_FIELDS:
        value = getattr(job.params, field)
        values = [value] if isinstance(value, str) else list(value or [])
        refs.extend((role, _shareable_file(item)) for item in values)
    return refs


def recipe_from_job_output(job_id: str, output_index: int) -> RecipeSource:
    job = _read_studio_job(job_id)
    output = _job_output(job, output_index)
    media_mime(output)
    refs = _job_ref_paths(job)
    inputs = [_recipe_input(order, role, path) for order, (role, path) in enumerate(refs)]
    cost_cny, cost_basis = _job_cost(job)
    recipe = GenerationRecipe(
        mode=job.kind.value, model=job.model, provider=job.provider, alias=job.alias,
        final_prompt=job.prompt, draft_prompt=None,
        params=recipe_params(job.params.model_dump(mode="json", exclude_none=True)),
        inputs=inputs, cost_cny=cost_cny, cost_basis=cost_basis, submitted_at=job.submitted_at,
    )
    return RecipeSource(
        media_path=output, media_filename=output.name, recipe=recipe,
        input_paths=[path for _, path in refs], origin_job_id=job.job_id,
        origin_canvas_project_id=None,
    )


# --------------------------------------------------------------- canvas_result


def _canvas_media(project_id: str, version_id: str) -> Path:
    """resolve_canvas_media 是画布媒体的路径闸：版本必须在本项目文档里，resolve 后（symlink
    已展开）必须在本项目 uploads / derived / outputs 内，outputs 还须登记在本项目的画布 job 上。"""
    try:
        path, _version = resolve_canvas_media(project_id, version_id)
    except PermissionError as error:
        raise RecipeSourceError("not_shareable", "画布媒体不在本画布项目内") from error
    except (FileNotFoundError, KeyError) as error:
        raise RecipeSourceError("source_missing", "本机找不到画布里的这份媒体") from error
    return path


def _read_document(project_id: str) -> CanvasDocument:
    try:
        return read_canvas_document(project_id)
    except (KeyError, FileNotFoundError) as error:
        raise RecipeSourceNotFound(project_id) from error


def _node_holds_version(document: CanvasDocument, node_id: str, version_id: str,
                        job: Job | None) -> bool:
    """版本「在」这个节点：是它的当前版本，或是它承载的那次 run 的某个候选。"""
    node = next((row for row in document.nodes if row.id == node_id), None)
    if node is None or node.type not in {"text", "image", "video", "audio"}:
        return False
    if node.data.current_version_id == version_id:
        return True
    context = job.canvas_run if job is not None else None
    return (
        context is not None
        and context.result_node_id == node_id
        and any(row.version_id == version_id for row in context.candidates)
    )


def _canvas_job(project_id: str, version: CanvasMediaVersion) -> Job:
    try:
        job = read_job(version.origin.job_id)
    except FileNotFoundError as error:
        raise RecipeSourceError("source_missing", "本机找不到这次生成的记录") from error
    if (
        job.namespace != "canvas" or job.canvas_project_id != project_id
        or job.canvas_run is None
    ):
        raise RecipeSourceError("not_shareable", "这次生成不属于本画布项目")
    return job


def _clean_canvas_prompt(snapshot: CanvasGenerationSnapshot) -> str:
    """去掉画布冻结时补在开头的编号说明，配方里只留画师自己的提示词；末尾的「参考文本」保留
    ——文本输入不进 recipe.inputs，内容只在这里。"""
    return snapshot.final_prompt.removeprefix(canvas_numbering_prefix(snapshot.inputs))


def recipe_from_canvas_result(
    canvas_project_id: str, node_id: str, version_id: str
) -> RecipeSource:
    document = _read_document(canvas_project_id)
    version = document.content_versions.get(version_id)
    if version is None:
        raise RecipeSourceNotFound(version_id)
    is_generated = version.origin.kind == "job_output"
    job = _canvas_job(canvas_project_id, version) if is_generated else None
    if not _node_holds_version(document, node_id, version_id, job):
        raise RecipeSourceNotFound(node_id)
    if job is None or not isinstance(version, CanvasMediaVersion):
        raise RecipeSourceError("not_shareable", "只有生成的图片与视频结果可以分享")
    snapshot = job.canvas_run.snapshot
    if version.kind not in _RECIPE_MODES or snapshot.mode not in _RECIPE_MODES:
        raise RecipeSourceError("not_shareable", "只有生成的图片与视频结果可以分享")

    media = _canvas_media(canvas_project_id, version_id)
    media_mime(media)
    refs: list[tuple[RecipeInputRole, Path]] = [
        ("reference", _canvas_media(canvas_project_id, row.version_id))
        for row in snapshot.inputs if row.kind != "text"
    ]
    if snapshot.mask_version_id is not None:
        refs.append(("mask", _canvas_media(canvas_project_id, snapshot.mask_version_id)))
    inputs = [_recipe_input(order, role, path) for order, (role, path) in enumerate(refs)]
    cost_cny, cost_basis = _job_cost(job)
    recipe = GenerationRecipe(
        mode=snapshot.mode, model=snapshot.model, provider=snapshot.provider,
        alias=snapshot.alias, final_prompt=_clean_canvas_prompt(snapshot),
        draft_prompt=snapshot.draft_prompt, params=recipe_params(snapshot.normalized_params),
        inputs=inputs, cost_cny=cost_cny, cost_basis=cost_basis,
        submitted_at=snapshot.submitted_at,
    )
    return RecipeSource(
        media_path=media, media_filename=media.name, recipe=recipe,
        input_paths=[path for _, path in refs], origin_job_id=job.job_id,
        origin_canvas_project_id=canvas_project_id,
    )


# ------------------------------------------------------ save_generation_asset


def _store(path: Path, filename: str) -> CreationMediaAssetContent:
    mime = media_mime(path)
    try:
        body = path.read_bytes()
    except FileNotFoundError as error:
        raise RecipeSourceError("source_missing", f"本机找不到文件：{path.name}") from error
    try:
        return store_media_blob(body, filename, mime)
    except ValueError as error:
        raise RecipeSourceError("not_shareable", str(error)) from error


def save_generation_asset(
    source: RecipeSource, *, title: str, tags: list[str], project_id: str | None
) -> CreationAsset:
    """成片与每份参考按内容落进 blobs，再建一条生成资产。快照里参考的 sha / 类型取落盘那份字节。"""
    clean_title = _required_text(title, "资产标题")
    if len(clean_title) > _TITLE_MAX_LENGTH:
        raise ValueError(f"资产标题不能超过 {_TITLE_MAX_LENGTH} 个字符")
    clean_tags = _normalize_tags(tags)
    if len(clean_tags) > _TAG_MAX_COUNT:
        raise ValueError(f"标签不能超过 {_TAG_MAX_COUNT} 个")
    media = _store(source.media_path, source.media_filename)
    inputs = []
    for row, path in zip(source.recipe.inputs, source.input_paths, strict=True):
        stored = _store(path, path.name)
        inputs.append(RecipeInput(
            order=row.order, role=row.role, kind=stored.mime_type.split("/", 1)[0],
            sha256=stored.sha256, mime_type=stored.mime_type,
        ))
    recipe = GenerationRecipe.model_validate({
        **source.recipe.model_dump(mode="json", exclude={"inputs"}),
        "inputs": [row.model_dump(mode="json") for row in inputs],
    })
    return create_generation_asset(
        title=clean_title, tags=clean_tags, media=media, snapshot=recipe, project_id=project_id,
    )
