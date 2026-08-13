"""Job runner — turns PENDING_CONFIRM JSON jobs into durable image/video assets."""
from __future__ import annotations

import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib import net_env
from character_workflow.lib.callers import dispatch, dispatch_video
from character_workflow.lib.active_character import read_active
from character_workflow.lib.jobs import (
    job_output_dir_for,
    list_jobs,
    read_job,
    save_job,
    update_job_phase,
    update_job_status,
)
from character_workflow.lib.schemas import AssetSlot, Job, JobParams, JobStatus


class JobRunnerError(RuntimeError):
    pass


def _friendly_error(err: BaseException) -> str:
    """把底层网络异常翻成画师能看懂的中文落进 job.error；其它原样返回。"""
    low = str(err).lower()
    if "proxy" in low and ("connect" in low or "proxyerror" in low or "max retries" in low):
        return (
            "连不上本机代理（VPN / Clash 等）。这些国产厂商无需翻墙：请在代理工具里"
            "关闭代理，或把厂商域名加入直连/绕过规则后重试。"
        )
    # 上传阶段超时：urllib3 用 connect 超时兜请求体上传，参考图偏大 / 上行慢会在传图时 write 超时。
    if "write operation timed out" in low or ("aborted" in low and "write" in low):
        return (
            "上传参考图超时：参考图偏大或上行网络偏慢，未能在时限内传完。"
            "请压小参考图或换更快的网络后重试。"
        )
    # 连接已建立但被远端中途掐断：多是该生成过重 / 上游太慢超出厂商网关等待时限（非本机网络问题）。
    if (
        "remote end closed" in low
        or "remotedisconnected" in low
        or "connection reset" in low
        or "reset by peer" in low
        or "connection aborted" in low
    ):
        return (
            "厂商网关中途断开连接：通常是该生成过重 / 上游太慢，超出了厂商网关的等待时限"
            "（与本机网络无关）。请换更小的生成规模，或换模型 / 换厂商（如 seedream）重试。"
        )
    if "timed out" in low or "timeout" in low:
        return "厂商接口超时未响应：可能是该模型上游过载，请稍后重试或换模型。"
    if "max retries" in low or "failed to establish" in low or (
        "connection" in low and "refused" in low
    ):
        return "网络连不上厂商接口：请检查网络 / 代理设置，确认厂商域名可访问后重试。"
    # 网关按协议挂端点，「无可用端点」= 该模型在这把 key 下压根没有可调的端点。必须排在
    # 下面的「网关瞬时超时」之前：它是确定性错误，重试无用，翻成瞬时问题会误导画师干等。
    if "no_endpoints_available" in low or "无可用端点" in low:
        return (
            "该模型在厂商网关下没有可用端点：通常是账号未开通这个模型，或它不支持当前"
            "调用协议。请到厂商控制台确认已开通，或在设置页重新拉一次模型列表后换用"
            f"同族其他模型。（原始报错：{err}）"
        )
    if "must be at least" in low and "pixel" in low:
        return (
            "出图尺寸低于该模型的像素下限：请把尺寸调大（或换用同族里下限更低的模型）后重试。"
            f"（原始报错：{err}）"
        )
    if "quota" in low or "insufficient" in low or "余额" in low or "额度" in low or "欠费" in low:
        return f"厂商额度 / 余额不足：请到厂商官网充值或检查账户额度后重试。（原始报错：{err}）"
    if "gateway" in low or "网关" in low or "bad response status code" in low:
        return (
            "厂商网关瞬时超时（已自动重试仍失败）：通常是该模型上游过载或排队，"
            f"请稍后重试或换模型。（原始报错：{err}）"
        )
    return str(err)


def _project_root() -> Path:
    return data_root.resolve_data_root()


def _params(job: Job) -> dict[str, Any]:
    return job.params.model_dump()


def _save_params(job: Job, params: dict[str, Any]) -> Job:
    return save_job(job.model_copy(update={"params": JobParams(**params)}))


def _normalize_reference_images(job: Job) -> Job:
    params = _params(job)
    refs = list(params.get("reference_images") or [])
    if job.source_image and job.source_image not in refs:
        refs.append(job.source_image)
    params["reference_images"] = refs
    if params.get("requested_size") is None and params.get("size"):
        params["requested_size"] = params["size"]
    return _save_params(job, params)


def _png_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or not data.startswith(b"\xff\xd8"):
        return None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
            height = int.from_bytes(data[i + 5:i + 7], "big")
            width = int.from_bytes(data[i + 7:i + 9], "big")
            return width, height
        size = int.from_bytes(data[i + 2:i + 4], "big")
        if size < 2:
            return None
        i += 2 + size
    return None


def _webp_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    kind = data[12:16]
    if kind == b"VP8X" and len(data) >= 30:
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if kind == b"VP8 " and len(data) >= 30:
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return width, height
    return None


def image_dimensions(path: Path) -> tuple[int, int] | None:
    if not path.exists() or path.stat().st_size <= 0:
        return None
    data = path.read_bytes()[:262144]
    for parser in (_png_dimensions, _jpeg_dimensions, _webp_dimensions):
        dims = parser(data)
        if dims and dims[0] > 0 and dims[1] > 0:
            return dims
    return None


def is_valid_image(path: Path) -> bool:
    return image_dimensions(path) is not None


def is_valid_video(path: Path) -> bool:
    if not path.exists() or path.stat().st_size <= 0:
        return False
    with path.open("rb") as fh:
        head = fh.read(16)
    # mp4/mov: "ftyp" box 在偏移 4；webm/mkv: EBML magic 在字节 0
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return True
    if head[:4] == b"\x1aE\xdf\xa3":
        return True
    return False


def _next_asset_path(output_dir: Path, ext: str = "png") -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    n = 1
    while True:
        path = output_dir / f"v{n}.{ext}"
        if not path.exists():
            return path
        n += 1


def _write_sidecar(path: Path, job: Job, params: dict[str, Any]) -> None:
    created_at = datetime.now(timezone.utc).isoformat()
    lines = [
        f"# {path.stem}",
        "",
        f"- asset_slot: {job.asset_slot.value}",
        f"- job_id: {job.job_id}",
        f"- created_at: {created_at}",
        f"- source_image: {job.source_image or ''}",
        f"- requested_size: {params.get('requested_size') or params.get('size') or ''}",
        f"- actual_size: {params.get('actual_size') or ''}",
        f"- model: {job.model}",
    ]
    if job.screen_id:
        lines.insert(3, f"- screen_id: {job.screen_id}")
    path.with_suffix(".md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_job(job_id: str) -> Job:
    from character_workflow.lib.schemas import JobKind
    # 国产厂商 host 绕过系统/坏代理（NO_PROXY），覆盖 skill（run-job）与 Studio（后台任务）两条路。
    net_env.configure_proxy_bypass()
    job = read_job(job_id)
    # Studio jobs start PENDING (UI submit = consent); character jobs start PENDING_CONFIRM.
    allowed_statuses = (JobStatus.PENDING_CONFIRM, JobStatus.PENDING)
    if job.status not in allowed_statuses:
        raise JobRunnerError(f"job not in a runnable status (current: {job.status.value})")
    if job.kind == JobKind.VIDEO:
        return _run_video_job(job)

    job = _normalize_reference_images(job)
    params = _params(job)

    try:
        if not job.alias:
            raise JobRunnerError("job requires an alias to route to an image provider")
        if job.status == JobStatus.PENDING_CONFIRM:
            update_job_status(job.job_id, status=JobStatus.PENDING, error=None)
        with tempfile.TemporaryDirectory(prefix=f"{job.job_id}-{job.provider or 'image'}-") as tmp:
            paths = dispatch(
                prompt=job.prompt,
                model=job.model,
                alias=job.alias,
                output_dir=Path(tmp),
                n=params.get("n") or 1,
                size=params.get("size"),
                params=params,
            )
            selected = [(Path(p), dims) for p in paths if (dims := image_dimensions(Path(p)))]
            if not selected:
                raise JobRunnerError(f"{job.provider or job.alias} returned no valid image artifacts")

            output_dir = job_output_dir_for(job)
            output_paths: list[str] = []
            first_dims: tuple[int, int] | None = None
            for src, dims in selected[: max(1, int(params.get("n") or 1))]:
                target = _next_asset_path(output_dir)
                shutil.move(str(src), target)
                output_paths.append(str(target))
                first_dims = first_dims or dims
            if first_dims:
                params["actual_size"] = f"{first_dims[0]}x{first_dims[1]}"
            job = _save_params(read_job(job.job_id), params)
            for output_path in output_paths:
                _write_sidecar(Path(output_path), job, params)
            return update_job_status(
                job.job_id,
                status=JobStatus.DONE,
                output_paths=output_paths,
                error=None,
            )
    except Exception as e:
        update_job_status(job.job_id, status=JobStatus.FAILED, error=_friendly_error(e))
        if isinstance(e, JobRunnerError):
            raise
        raise JobRunnerError(str(e)) from e


def _run_video_job(job: Job) -> Job:
    """视频分支 —— 复用 PENDING→DONE/FAILED 脚手架的形状，但派发/校验/落盘换成视频版。

    不做图片专属的 image_dimensions / actual_size；输出 .mp4 到 job_output_dir_for(job)。
    """
    job = _normalize_reference_images(job)
    params = _params(job)
    try:
        if not job.alias:
            raise JobRunnerError("video job requires an alias to route to a provider")
        if job.status == JobStatus.PENDING_CONFIRM:
            update_job_status(job.job_id, status=JobStatus.PENDING, error=None)
        with tempfile.TemporaryDirectory(prefix=f"{job.job_id}-{job.provider or 'video'}-") as tmp:
            paths = dispatch_video(
                prompt=job.prompt,
                model=job.model,
                alias=job.alias,
                output_dir=Path(tmp),
                params=params,
                # 进度卡点回写 job 文件（sent/downloading），watcher SSE 推给前端。
                on_phase=lambda phase: update_job_phase(job.job_id, phase),
            )
            valid = [Path(p) for p in paths if is_valid_video(Path(p))]
            if not valid:
                raise JobRunnerError(f"{job.provider or job.alias} returned no valid video artifacts")

            output_dir = job_output_dir_for(job)
            # 视频无图片那种"出 n 张"概念：Seedance 单次返回一个视频，全部有效产物落盘，不设 n-cap。
            output_paths: list[str] = []
            for src in valid:
                target = _next_asset_path(output_dir, ext="mp4")
                shutil.move(str(src), target)
                output_paths.append(str(target))
            job = _save_params(read_job(job.job_id), params)
            for output_path in output_paths:
                _write_sidecar(Path(output_path), job, params)
            return update_job_status(
                job.job_id,
                status=JobStatus.DONE,
                output_paths=output_paths,
                error=None,
            )
    except Exception as e:
        update_job_status(job.job_id, status=JobStatus.FAILED, error=_friendly_error(e))
        if isinstance(e, JobRunnerError):
            raise
        raise JobRunnerError(str(e)) from e


def run_latest(
    *,
    kind: AssetSlot | None = None,
    character_id: str | None = None,
) -> Job:
    if character_id is None:
        active = read_active()
        character_id = active.active_id
    if not character_id:
        raise JobRunnerError("no active character")

    candidates = [
        job for job in list_jobs()
        if (
            job.character_id == character_id
            and job.status == JobStatus.PENDING_CONFIRM
            and (kind is None or job.asset_slot == kind)
        )
    ]
    if not candidates:
        suffix = f" asset_slot={kind.value}" if kind else ""
        raise JobRunnerError(f"no pending_confirm job for {character_id}{suffix}")
    candidates.sort(key=lambda j: (j.submitted_at, j.job_id))
    return run_job(candidates[-1].job_id)
