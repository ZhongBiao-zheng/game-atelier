"""Midjourney 任务代理协议（midjourney-proxy 兼容）图片 caller。

POST /mj/submit/imagine 拿 result 任务 ID → GET /mj/task/{id}/fetch 轮询 status →
SUCCESS 后取 imageUrls[].url，并通过 GET /mj/task/{id}/image-seed 取回实际 seed，最后拉字节
落 .png。鉴权 Authorization: Bearer <key>。
契约来源：https://api.tu-zi.com/docs/api/midjourney + apifox OpenAPI（343646946e0 / 343646941e0）。

与其他图片 caller 的三处结构性差异（都是 2026-08-17 对 Tuzi MJ 分组实测得来）：

1. **异步**。这是唯一走「提交 + 轮询」的图片协议，所以复用视频侧的 video_poll 轮询外壳
   （传输层失败不吃 max_polls 预算、报错必带 task_id），而不是 openai_image 的同步 POST。
   实测 FAST 档 37s 出图，窗口按 RELAX 档留到 6 分钟。

2. **一次出 4 张**。fetch 的 imageUrls 是 4 张独立 1024² 单图（上游已从 2048² 四宫格切好），
   imageUrl 则是那张四宫格。落盘只取 4 张单图 —— 四宫格与它们内容重复。
   因此前端对该族把张数锁 4：job_runner 会按 params.n 裁产物，n<4 会白扔已计费的图。

3. **参数走 prompt 尾部 flag**，body 里没有 size / quality 之类的字段。上游会解析并重组
   这些 flag，用户没给的补默认值（实测 finalPrompt: `<prompt> --ar 1:1 --v 7 --stylize 100
   --fast`），用户给了的归一化后合并（`--chaos 10` → `--c 10`）。所以比例、版本、风格化
   都从结构化 params 拼成 flag，而不是当 API 参数发。

一条排障笔记：提交阶段的 `insert_midjourney_task_failed`（HTTP 400）说的是「上游插不进这个
任务」，与 prompt 内容无关 —— 2026-08-17 实测同一条 prompt 在渠道空闲时受理、在渠道忙时被拒，
连不带任何 flag 的最短 prompt 也一样。所以不要据此推断某个参数非法；_friendly_error 里按
这个语义翻译。
"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import video_poll

# 提交受理码：1=成功，21=任务已存在（同 prompt 被兼容层归并），22=排队中。
_ACCEPTED_CODES = {1, 21, 22}

_TERMINAL_SUCCESS = "SUCCESS"
_TERMINAL_FAILURE = "FAILURE"

# sydney-ai 产物 CDN 会拦截 requests 默认 UA，返回 Cloudflare 403 挑战页。
# 这里只模拟普通的浏览器图片请求，不把 API Authorization 泄露给独立 CDN 域名。
_IMAGE_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}

# 上游错误码 → 中文。翻译的价值不在于「变成中文」，而在于把误导性的措辞纠正过来：
# insert_midjourney_task_failed 字面像参数错，实际是渠道侧接不下任务（见模块 docstring）。
_UPSTREAM_MESSAGES = {
    "insert_midjourney_task_failed": (
        "上游没能接下这个任务：Midjourney 渠道正忙或暂时不可用。这与 prompt 内容和参数无关"
        "（同一条 prompt 在渠道空闲时可以受理）。注意这类被拒的请求在聚合商侧仍可能按调用"
        "计费（2026-08-17 在 Tuzi 实测：每次被拒都有一条消费记录、无退款），所以不要反复重试"
        "碰运气 —— 先去供应商控制台看该分组的渠道状态。"
    ),
    "prompt_is_required": "Midjourney 需要非空 prompt",
    "task_no_found": "上游查不到这个任务（任务 ID 可能已过期）",
}


class MidjourneyError(RuntimeError):
    pass


def _api_root(key) -> str:
    """MJ 通道挂在站点根（/mj/...），而 key 的 base_url 可能带 OpenAI 兼容后缀（/v1），
    所以只取 scheme://host。与 kling_video._api_root 同构。"""
    raw = str(getattr(key, "base_url", None) or "")
    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        raise MidjourneyError(f"无效的 base_url: {raw!r}")
    return f"{parts.scheme}://{parts.netloc}"


def _json(resp) -> dict[str, Any]:
    try:
        payload = resp.json()
    except Exception as e:  # noqa: BLE001
        raise MidjourneyError(f"上游响应非 JSON: {getattr(resp, 'text', '')[:300]}") from e
    return payload if isinstance(payload, dict) else {}


def _err(payload: dict[str, Any], status_code: int) -> str:
    # failReason 必须排在 description 前面：轮询响应里的 description 恒为提交时那句
    # "Submit Success"，按 description 优先会把真正的失败原因（在 failReason 里）整条挡住，
    # 报出一个「错误消息是 Submit Success」的荒诞结果（2026-08-19 实测踩到）。
    raw = str(
        payload.get("failReason")
        or payload.get("description")
        or payload.get("message")
        or f"Midjourney 上游 HTTP {status_code}"
    ).strip()
    return _UPSTREAM_MESSAGES.get(raw, raw)


# 结构化参数 → flag 名 → 取值类型。MJ 的 body 没有 size / quality 字段，一切控制都在
# prompt 尾部的 flag 里；上游会把它们归一化后与自己的默认值合并（实测 --chaos 10 → --c 10）。
# 比例复用通用 ratio 字段（值形如 "16:9"），不另立 mj_ar —— 同一个语义不开两个字段。
# 版本不在这张表里：flag 名随 botType 变，见 _version_flag。
_FLAG_SPECS: tuple[tuple[str, str, Any], ...] = (
    ("ratio", "ar", str),
    ("mj_stylize", "stylize", int),
    ("mj_chaos", "chaos", int),
    ("mj_weird", "weird", int),
    ("mj_seed", "seed", int),
    ("mj_no", "no", str),
    ("mj_iw", "iw", float),
)


# 三种「参考图 flag」：(路径字段, flag 名, 权重字段, 权重 flag 名)。
# 值必须是**公网图片 URL** —— MJ 的 sref/cref/oref 不吃 base64（垫图才吃，走 body 的
# base64Array）。本地文件经 OSS 中转拿直链；MJ 自己的上传通道 /mj/submit/upload-discord-images
# 在 Tuzi 主 key 上无渠道（503 mj_upload），所以走本仓视频侧同一条 OSS 路。
_REF_FLAG_SPECS: tuple[tuple[str, str, str, str], ...] = (
    ("mj_sref", "sref", "mj_sw", "sw"),  # 风格参考 Style Reference，--sw 0-1000
    ("mj_cref", "cref", "mj_cw", "cw"),  # 角色参考 Character Reference，--cw 0-100
    ("mj_oref", "oref", "mj_ow", "ow"),  # Omni Reference，--ow 0-1000
)


def _public_url(path_or_url: str) -> str:
    """本地文件 → OSS 公开读直链；已经是 http(s) 的原样返回。

    必须是**无签名**的干净 URL：MJ 要求以图片扩展名结尾，presigned 那串 query 会被它
    判成 prompt 格式错误（见 oss_upload.upload_for_public_url 的说明）。
    """
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://")):
        return s
    from character_workflow.lib import oss_upload

    return oss_upload.upload_for_public_url(s)


# 角色类参考图的版本支持 —— 全部 2026-08-19 单变量实测（单独用、不带 sref）：
#   --cref: v6 ✓ SUCCESS    v8.2 ✗ FAILURE
#   --oref: v7 ✓ SUCCESS    v8.2 ✗ FAILURE
# 即 v8.2 这两个都还没接上（风格参考 --sref 在 v8.2 正常）。带上去不是被忽略，而是让
# 整个任务 FAILURE（[invalid_parameter] prompt 格式错误）—— 白付一次钱，所以提交前摘掉。
_REF_VERSION_SUPPORT: dict[str, set[str]] = {
    "cref": {"6", "6.0"},
    "oref": {"7", "7.0"},
}
_REF_SLOT_LABELS = {"cref": "角色参考", "oref": "Omni 参考"}
_MAX_REFS_PER_SLOT = 4


def _ref_flag_supported(flag: str, params: dict[str, Any]) -> bool:
    allowed = _REF_VERSION_SUPPORT.get(flag)
    if allowed is None:
        return True
    return str(params.get("mj_version") or "").strip() in allowed


def _ref_flags(params: dict[str, Any], params_in: dict[str, Any] | None = None) -> list[str]:
    """把 sref / cref / oref 及各自权重拼成 flag 片段。"""
    out: list[str] = []
    raw_sref_code = str(params.get("mj_sref_code") or "").strip()
    if raw_sref_code and not (raw_sref_code.isascii() and raw_sref_code.isdigit()):
        raise MidjourneyError("sref 编号只允许数字")
    for path_key, flag, weight_key, weight_flag in _REF_FLAG_SPECS:
        raw_refs = params.get(path_key)
        refs = [str(ref) for ref in raw_refs if ref] if isinstance(raw_refs, list) else []
        if flag == "sref" and raw_sref_code:
            if refs:
                _warn(params_in, "已使用 sref 编号，本次已忽略上传的风格参考图")
            out.append(f"--sref {raw_sref_code}")
            weight = params.get(weight_key)
            if weight is not None:
                out.append(f"--{weight_flag} {int(weight)}")
            continue
        if not refs:
            continue
        if len(refs) > _MAX_REFS_PER_SLOT:
            _warn(params_in, f"--{flag} 最多 {_MAX_REFS_PER_SLOT} 张，本次仅使用前 {_MAX_REFS_PER_SLOT} 张")
            refs = refs[:_MAX_REFS_PER_SLOT]
        if not _ref_flag_supported(flag, params):
            version = str(params.get("mj_version") or "?")
            ok = "/".join(f"v{v}" for v in sorted(_REF_VERSION_SUPPORT[flag]) if "." not in v)
            _warn(params_in, f"{_REF_SLOT_LABELS[flag]}（--{flag}）只在 {ok} 支持，"
                             f"当前是 v{version}，本次已忽略这组图；要用它请把版本切到 {ok}。")
            continue
        urls = " ".join(_public_url(ref) for ref in refs)
        out.append(f"--{flag} {urls}")
        weight = params.get(weight_key)
        if weight is not None:
            out.append(f"--{weight_flag} {int(weight)}")
    return out


def _version_flag(params: dict[str, Any]) -> str | None:
    """版本 flag —— niji 与 Midjourney 是两套体系，flag 名和版本号都不通用。

    Midjourney: `--v 7` / `6.1` / `6`；niji: `--niji 6` / `5`。
    拿 niji 的版本号去发 `--v`（或反过来）等于发一个不存在的组合，所以 flag 名必须
    跟着 botType 走，前端的版本档位也按同一判据切换。
    """
    version = str(params.get("mj_version") or "").strip()
    if not version:
        return None
    niji = str(params.get("bot_type") or "").strip().upper() == "NIJI_JOURNEY"
    return f"--niji {version}" if niji else f"--v {version}"


def _append_flags(prompt: str, params: dict[str, Any],
                  params_in: dict[str, Any] | None = None) -> str:
    """把结构化 MJ 参数拼成 flag 追加到 prompt 尾部。

    在 caller 拼而不在前端拼：job.prompt 保持画师原文，换到别的模型时不残留 MJ flag。
    """
    parts = [prompt.strip()]
    version_flag = _version_flag(params)
    if version_flag:
        parts.append(version_flag)
    for key, flag, cast in _FLAG_SPECS:
        value = params.get(key)
        if value is None or value == "":
            continue
        parts.append(f"--{flag} {cast(value)}")
    parts.extend(_ref_flags(params, params_in))
    if params.get("mj_tile"):
        parts.append("--tile")  # 无值开关
    return " ".join(parts)


def _submit_body(prompt: str, params: dict[str, Any], params_in: dict[str, Any] | None = None) -> dict[str, Any]:
    """只发拿到值的字段。

    botType / accountFilter 在本渠道尚无实测结论，所以默认不发 —— 不传等于走上游默认
    预设（实测可用），凭猜发反而可能整条链路 400。前端确认可用后再从 params 传进来。
    """
    body: dict[str, Any] = {"prompt": prompt}
    bot_type = str(params.get("bot_type") or "").strip().upper()
    if bot_type:
        body["botType"] = bot_type
    mode = str(params.get("mode") or "").strip().upper()
    if mode:
        body["accountFilter"] = {"modes": [mode]}
    refs = [str(r) for r in (params.get("reference_images") or []) if r]
    if len(refs) > _MAX_REFS_PER_SLOT:
        _warn(params_in, f"Midjourney 垫图最多 {_MAX_REFS_PER_SLOT} 张，本次仅使用前 {_MAX_REFS_PER_SLOT} 张")
        refs = refs[:_MAX_REFS_PER_SLOT]
    if refs:
        body["base64Array"] = [_ref_payload(r) for r in refs]
    return body


def _ref_payload(path_or_url: str) -> str:
    """垫图字段收 base64 数组。公网直链按上游文档的建议留在 prompt 里，不进 base64Array。"""
    import base64
    import mimetypes

    s = str(path_or_url).strip()
    if s.startswith("data:"):
        return s
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise MidjourneyError(f"读取垫图失败: {s}: {e}") from e
    mime = mimetypes.guess_type(s)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _warn(params_in: dict[str, Any] | None, message: str) -> None:
    """后端的静默改写必须有回传通道 —— 卡片会把 warnings 摊给画师看。"""
    if params_in is None:
        return
    warnings = params_in.setdefault("warnings", [])
    if isinstance(warnings, list) and message not in warnings:
        warnings.append(message)


def _publish_actual_n(params_in: dict[str, Any] | None, wanted: int, actual: int) -> None:
    """把「上游一次出 4 张」回写进 job 的 params。

    job_runner 按 params.n 裁产物：skill 侧默认 n=1，不回写就会丢掉 3 张已经计费的图。
    同时留一条 warning —— 后端改写必须有回传通道，否则画师看到的张数与实际不符也无从得知。
    """
    if params_in is None or actual == wanted:
        return
    params_in["n"] = actual
    _warn(params_in, f"Midjourney 一次出 {actual} 张方案（请求 {wanted} 张），已全部保留")


def _extract_task_id(payload: dict[str, Any]) -> str:
    # spec 把 result 标成 integer，实际返回字符串数字（1786973745670123），统一按 str 用。
    v = payload.get("result")
    return str(v).strip() if v not in (None, "") else ""


def _image_urls(payload: dict[str, Any]) -> list[str]:
    """只取 imageUrls[].url 的 4 张单图；imageUrl（四宫格拼图）与它们内容重复，不落盘。"""
    urls: list[str] = []
    for item in payload.get("imageUrls") or []:
        url = item.get("url") if isinstance(item, dict) else item
        if isinstance(url, str) and url.startswith("http"):
            urls.append(url)
    if urls:
        return urls
    # 兜底：某些动作（upscale 等）只回单图，没有 imageUrls 数组。
    single = payload.get("imageUrl")
    return [single] if isinstance(single, str) and single.startswith("http") else []


def _download_png(url: str, output_dir: Path, index: int, *, task_ref: str = "") -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, headers=_IMAGE_DOWNLOAD_HEADERS, timeout=300)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 任务已跑完并计费，只是产物没拉下来 —— 带上 task_id 和源地址供人工找回。
        raise MidjourneyError(
            video_poll.with_task_ref(f"下载 Midjourney 产物失败（源地址 {url}）: {e}", task_ref)
        ) from e
    path = output_dir / f"mj{index}.png"
    path.write_bytes(resp.content)
    return str(path)


def _poll_task(
    *, root: str, headers: dict[str, str], task_id: str,
    max_polls: int, poll_interval: float, should_cancel: Callable[[], bool] | None = None,
) -> list[str]:
    """轮询到终态，返回产物地址列表。

    网络抖动 / 5xx 交给 video_poll 吞掉重试（不扣 max_polls）；这里只解读 body 里的 status。
    此处所有失败路径都对应一个已提交、已计费的任务，报错一律带 task_id。
    """
    url = f"{root}/mj/task/{task_id}/fetch"
    for resp in video_poll.poll_responses(
        url=url, headers=headers, timeout=60, max_polls=max_polls,
        poll_interval=poll_interval, task_ref=task_id, error_cls=MidjourneyError,
        should_cancel=should_cancel,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise MidjourneyError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
        status = str(payload.get("status") or "").strip().upper()
        if status == _TERMINAL_SUCCESS:
            urls = _image_urls(payload)
            if urls:
                return urls
            raise MidjourneyError(
                video_poll.with_task_ref("Midjourney 任务成功但未返回图片地址", task_id)
            )
        if status == _TERMINAL_FAILURE:
            raise MidjourneyError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
    raise MidjourneyError(f"Midjourney 任务轮询超时: {task_id}")


def _fetch_image_seed(*, root: str, headers: dict[str, str], task_id: str) -> int | None:
    """取回本次生成实际使用的 seed。

    midjourney-proxy 的 fetch 终态不含 seed，需要另打 image-seed。这个接口依赖渠道的 Bot
    私信配置，失败时只能缺省元数据，不能把已经成功并计费的图片判成失败。
    """
    try:
        resp = requests.get(
            f"{root}/mj/task/{task_id}/image-seed",
            headers=headers,
            timeout=60,
        )
        payload = _json(resp)
    except (requests.RequestException, MidjourneyError):
        return None
    if not resp.ok or payload.get("code") != 1:
        return None
    raw = payload.get("result")
    try:
        seed = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return seed if seed >= 0 else None


def render(
    *,
    prompt: str,
    model: str,
    alias: str | None,
    output_dir: Path | str,
    n: int = 4,
    params: dict[str, Any] | None = None,
    max_polls: int = 120,
    poll_interval: float = 3.0,
    on_phase: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_kwargs,
) -> list[str]:
    """提交 imagine 任务并轮询取图，返回本地 .png 路径 list[str]。

    n 是**要几张图**，不是提交几次：一次 imagine 回 4 张，所以按 ceil(n/4) 次提交，
    多出来的图照常落盘交给 job_runner 按 params.n 裁（少提交一次比少拿几张更省钱）。
    on_phase: 进度卡点回调 —— 全部提交成功后 "sent"、开始下载产物时 "downloading"。
    """
    # 保留外部原 dict 的引用：job_runner 把它存回 job 文件，实际张数要能回写过去。
    params_in = params if isinstance(params, dict) else None
    params = dict(params or {})
    if not (prompt or "").strip():
        raise MidjourneyError("Midjourney 需要非空 prompt")
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise MidjourneyError(f"未找到 Key: {alias}")
    root = _api_root(key)
    headers = {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"}
    final_prompt = _append_flags(prompt, params, params_in)
    # 把真实发出的 flag 串回写给 job，出图卡片直接展示它 —— 展示「实际发了什么」而不是
    # 让前端照 params 再拼一遍（两处拼接必然漂移）。
    flags = final_prompt[len(prompt.strip()):].strip()
    if params_in is not None and flags:
        params_in["mj_flags"] = flags
    body = _submit_body(final_prompt, params, params_in)

    wanted = max(1, int(n or 1))
    submissions = -(-wanted // 4)  # ceil：一次 imagine 出 4 张

    task_ids: list[str] = []
    for _ in range(submissions):
        resp = requests.post(f"{root}/mj/submit/imagine", headers=headers, json=body, timeout=120)
        payload = _json(resp)
        code = payload.get("code")
        if not resp.ok or code not in _ACCEPTED_CODES:
            raise MidjourneyError(_err(payload, resp.status_code))
        task_id = _extract_task_id(payload)
        if not task_id:
            raise MidjourneyError(f"Midjourney 提交后未返回任务 ID: {payload!r}")
        task_ids.append(task_id)
    if on_phase:
        on_phase("sent")

    out_dir = Path(output_dir)
    paths: list[str] = []
    downloading = False
    for task_id in task_ids:
        urls = _poll_task(
            root=root, headers=headers, task_id=task_id,
            max_polls=max_polls, poll_interval=poll_interval,
            should_cancel=should_cancel,
        )
        # UI 的 Midjourney 一次任务固定返回 4 张，共享同一个 seed。多任务（n>4）会有多个
        # seed，现有 JobParams 没有可准确表达它们的字段，因此只在单任务时回填。
        if len(task_ids) == 1 and params.get("mj_seed") in (None, ""):
            generated_seed = _fetch_image_seed(root=root, headers=headers, task_id=task_id)
            if generated_seed is not None:
                params["mj_seed"] = generated_seed
                if params_in is not None:
                    params_in["mj_seed"] = generated_seed
            else:
                _warn(
                    params_in,
                    "未能取回 Midjourney seed；渠道需要配置 Bot 私信 ID，图片结果不受影响",
                )
        for url in urls:
            if on_phase and not downloading:
                downloading = True
                on_phase("downloading")
            paths.append(_download_png(url, out_dir, len(paths) + 1, task_ref=task_id))
    _publish_actual_n(params_in, wanted, len(paths))
    return paths
