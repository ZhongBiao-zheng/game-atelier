"""抽帧计划与输出尺寸：纯函数，界面预览用同一套算法（ui/src/plan.ts），两边跑 tests/plan_cases.json。

取整一律用 floor(x + 0.5)：Python 的 round() 是银行家舍入，JS 的 Math.round 不是，两边会差一帧。
"""
from __future__ import annotations

import math
from typing import Any

MAX_FRAMES = 65  # 结果组上限：封面 + 64 个成员
MODES = ("count", "step", "rate")
LONG_EDGE_RANGE = (16, 4096)


def _half_up(value: float) -> int:
    return math.floor(value + 0.5)


def _int(params: dict[str, Any], key: str, default: int) -> int:
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("抽帧参数不对")
    return int(value)


def plan_frames(frame_count: int, fps: float, params: dict[str, Any]) -> list[int]:
    """要抽的帧号（从 0 起、升序、不重复）。区间含首尾。"""
    if not fps or fps <= 0 or not math.isfinite(fps):
        raise ValueError("读不出视频的帧率")
    if frame_count < 1:
        raise ValueError("视频里没有可读的帧")
    start = _int(params, "start", 0)
    end_raw = params.get("end")
    end = frame_count - 1 if end_raw is None else min(_int(params, "end", 0), frame_count - 1)
    if start < 0 or start >= frame_count:
        raise ValueError("起始帧超出了视频")
    if end < start:
        raise ValueError("结束帧要在起始帧之后")
    mode = params.get("mode", "count")
    if mode not in MODES:
        raise ValueError("抽帧方式不对")
    if mode == "count":
        count = _int(params, "count", 12)
        if not 1 <= count <= MAX_FRAMES:
            raise ValueError(f"帧数要在 1 到 {MAX_FRAMES} 之间")
        raw = [start] if count == 1 else [_half_up(start + index * (end - start) / (count - 1)) for index in range(count)]
    elif mode == "step":
        step = _int(params, "step", 1)
        if step < 1:
            raise ValueError("间隔至少 1 帧")
        raw = list(range(start, end + 1, step))
    else:
        rate = _int(params, "rate", 12)
        if rate < 1:
            raise ValueError("每秒至少 1 帧")
        interval = max(1.0, fps / rate)
        raw, index = [], 0
        while (frame := _half_up(start + index * interval)) <= end:
            raw.append(frame)
            index += 1
    frames = list(dict.fromkeys(raw))
    if len(frames) > MAX_FRAMES:
        raise ValueError(f"最多 {MAX_FRAMES} 帧，现在是 {len(frames)} 帧")
    return frames


def output_size(width: int, height: int, long_edge: int | None) -> tuple[int, int]:
    """按长边缩放到 long_edge（等比）；None 表示原尺寸。"""
    if long_edge is None:
        return width, height
    if isinstance(long_edge, bool) or not isinstance(long_edge, int) \
            or not LONG_EDGE_RANGE[0] <= long_edge <= LONG_EDGE_RANGE[1]:
        raise ValueError(f"长边要在 {LONG_EDGE_RANGE[0]} 到 {LONG_EDGE_RANGE[1]} 像素之间")
    scale = long_edge / max(width, height)
    return max(1, _half_up(width * scale)), max(1, _half_up(height * scale))
