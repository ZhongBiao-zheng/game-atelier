"""Lovart 调用包装 —— 三 Skill 共用。

把 SKILL.md / references/lovart-call.md 里的 subprocess 调用代码搬到这里，
让 jobs.py 和上层 Skill 不直接拼 CLI args。
默认拉 GPT Image 2（`generate_image_gpt_image_2`）；其他模型可显式传 model 参数。

成功 → 返回 `LovartResult(output_paths=[...], raw_json={...})`
失败 → 抛 `LovartError`；超时 → 抛 `LovartTimeout`（subclass of LovartError）

Lovart CLI 安装在 ~/.claude/skills/lovart-api/，由 LOVART_CLI 环境变量覆盖。
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_LOVART_CLI = Path.home() / ".claude" / "skills" / "lovart-api" / "lovart"


class LovartError(RuntimeError):
    pass


class LovartTimeout(LovartError):
    pass


@dataclass
class LovartResult:
    output_paths: list[str]
    raw_json: dict = field(default_factory=dict)


def _cli_path() -> Path:
    return Path(os.environ.get("LOVART_CLI", DEFAULT_LOVART_CLI))


def _build_cmd(
    *, prompt: str, model: str, output_dir: Path,
    n: int, reference_images: list[str] | None,
) -> list[str]:
    cmd: list[str] = [
        str(_cli_path()),
        "--include-tools", model,
        "--output-dir", str(output_dir),
        "--json", "--download",
        "--n", str(n),
        "--prompt", prompt,
    ]
    for img in reference_images or []:
        cmd.extend(["--reference-image", img])
    return cmd


def submit_and_wait(
    *, prompt: str, model: str = "generate_image_gpt_image_2",
    output_dir: Path, n: int = 1,
    reference_images: list[str] | None = None,
    timeout: float = 600.0,
) -> LovartResult:
    """同步调 lovart-api，阻塞到返回。

    成功：返回 LovartResult。
    非零退出：raise LovartError(stderr)。
    超时：raise LovartTimeout。
    输出 JSON 无法解析：raise LovartError("unparseable output: ...")。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = _build_cmd(
        prompt=prompt, model=model, output_dir=output_dir,
        n=n, reference_images=reference_images,
    )
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise LovartTimeout(f"lovart-api timed out after {timeout}s") from e

    if result.returncode != 0:
        raise LovartError(
            f"lovart-api exit {result.returncode}: {result.stderr.strip() or result.stdout.strip()}"
        )

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise LovartError(f"unparseable output: {e}; raw={result.stdout[:200]!r}") from None

    paths = payload.get("output_paths") or payload.get("downloaded_paths") or []
    if not paths or not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        raise LovartError(f"output_paths missing or malformed in lovart-api response: {payload!r}")
    return LovartResult(output_paths=paths, raw_json=payload)
