"""视频异步任务轮询的公共外壳（四家视频 caller 共用）。

为什么要单独抽一层：视频任务的轮询窗口是 15-30 分钟（180×5s / 120×15s），
这段时间里本机网络抖一下是常态（Clash 切节点、DNS 解析失败、TCP 被重置）。
原先四个 caller 的轮询 GET 全裸奔，一次抖动就冒泡到 job_runner 把 job 标 FAILED
—— 而上游任务照常跑完照常计费，产物没人认领（task_id / hosted url 过期后彻底丢），
画师重试等于再付一次钱。

两条政策必须四家一致，所以收在这里而不是各写一份：
1. 传输层失败（RequestException / 5xx）只说明「这次没问到」，不说明「任务失败」。
   终态判定只认上游 body 里的 status。
2. 这类失败不吃 max_polls 预算——否则一次抖动等价于偷偷缩短轮询窗口，
   长任务会在真出结果前被判超时。
"""
from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from math import ceil
from typing import Any

import requests

# 容忍窗口按墙钟时间定，不按次数：四家的 poll_interval 差 3 倍（5s vs 15s），
# 定成固定次数会让同一次 Clash 切节点在 Seedance 上只忍 30s、在 HappyHorse 上忍 90s，
# 同一个故障在不同厂商表现不一致，排障时会误判成「某厂商特别脆」。
# 90s 的依据：切节点 / VPN 重连恢复通常在 10-20s 内，90s 留足余量；再长就不是抖动
# 而是网络真断了，那时候早点报错并交出 task_id 比继续干等有用。
_TRANSIENT_WINDOW_SECONDS = 90.0
_MIN_TRANSIENT_TRIES = 3


def _transient_limit(poll_interval: float) -> int:
    # poll_interval=0 是测试里的快进档，按 1s 折算，避免除零 / 窗口退化成 0 次。
    step = max(float(poll_interval or 0.0), 1.0)
    return max(_MIN_TRANSIENT_TRIES, ceil(_TRANSIENT_WINDOW_SECONDS / step))


def _is_transient_status(code: int) -> bool:
    """轮询期该把这个 HTTP 状态当「还没问到」还是「任务失败」。

    取舍与提交阶段相反：提交阶段失败没有已计费的任务要保，当场报错最省事；
    轮询阶段一次误判就把正在跑、已经计费的任务判死，所以宁可多等几轮。
    5xx 一律算传输 / 网关侧问题（上游从不用 5xx 表达任务结论，任务失败走 200 + status）；
    408 / 429 是明确的「稍后再问」。其余 4xx（401 鉴权、403 未开通、404 任务不存在）
    重试无用，保持当场致命。
    """
    return code >= 500 or code in (408, 429)


def with_task_ref(message: str, task_ref: str) -> str:
    """给「任务已提交成功之后」的报错补上任务标识，留人工找回的钩子。"""
    return f"{message}（task_id={task_ref}）" if task_ref else message


def _abandon_message(task_ref: str, tries: int, status_code: int | None) -> str:
    """连续失败到放弃时的文案。

    刻意不把原始异常文本拼进来：job_runner._friendly_error 是按英文关键词整条替换
    消息的（timed out / connection reset / gateway / max retries …），一旦命中，
    这里辛苦带上的 task_id 会连同原文一起被换成一句通用提示，人工找回的钩子就没了。
    原始异常走 `raise ... from e` 留在 traceback / 日志里，诊断信息并不丢。
    """
    cause = (
        f"上游连续返回 HTTP {status_code}" if status_code
        else "本机到厂商的请求连续没能完成"
    )
    ref = f"（task_id={task_ref}）" if task_ref else ""
    return (
        f"查询任务状态连续失败 {tries} 次，已停止等待{ref}：{cause}。"
        "该任务大概率仍在厂商侧继续跑（并已计费），可凭上面的标识到厂商控制台取回产物；"
        "直接重试会二次计费。"
    )


def poll_responses(
    *,
    url: str,
    headers: dict[str, str],
    timeout: float,
    max_polls: int,
    poll_interval: float,
    task_ref: str,
    error_cls: type[Exception],
    should_cancel: Callable[[], bool] | None = None,
) -> Iterator[Any]:
    """按 poll_interval 节奏轮询 GET，逐次 yield「值得解读」的响应。

    可恢复失败（网络异常 / 5xx / 408 / 429）在内部吞掉重试：不 yield，也不扣
    max_polls。只有连续失败到超出容忍窗口才抛 error_cls，且消息里必带 task_ref。
    生成器正常耗尽 = 真的问了 max_polls 次仍无终态，由调用方按自己的文案报超时。
    """
    limit = _transient_limit(poll_interval)
    consecutive = 0
    polls_left = max_polls
    while polls_left > 0:
        if should_cancel and should_cancel():
            raise error_cls(with_task_ref("生成已按请求停止", task_ref))
        if poll_interval:
            time.sleep(poll_interval)
        if should_cancel and should_cancel():
            raise error_cls(with_task_ref("生成已按请求停止", task_ref))
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
        except requests.RequestException as e:
            consecutive += 1
            if consecutive >= limit:
                raise error_cls(_abandon_message(task_ref, consecutive, None)) from e
            continue
        if _is_transient_status(int(getattr(resp, "status_code", 0) or 0)):
            consecutive += 1
            if consecutive >= limit:
                raise error_cls(_abandon_message(task_ref, consecutive, resp.status_code))
            continue
        # 问到了一次有效答复：抖动计数清零，这一轮才算真的花掉一次 max_polls 预算。
        consecutive = 0
        polls_left -= 1
        yield resp


def sent_url_set(urls: list[str]) -> set[str]:
    """把本次请求发出去的公网 URL 收成排除集（同时收录去 query 的形式）。

    上游成功响应会回显输入（Ark 的 content[] 就是请求体里那个键），而参考视频按契约
    必须是公网直链，剥掉 query 后就是 .mp4 —— 扩展名过滤根本拦不住。带 query 的
    预签名直链回显时 query 可能被改写，所以按「去 query 的路径」也比一次。
    """
    out: set[str] = set()
    for u in urls:
        s = str(u).strip()
        if not s.startswith(("http://", "https://")):
            continue
        out.add(s)
        out.add(strip_query(s))
    return out


def strip_query(url: str) -> str:
    return url.split("?", 1)[0].split("#", 1)[0]


def is_echoed_input(url: str, sent: set[str] | None) -> bool:
    return bool(sent) and (url in sent or strip_query(url) in sent)
