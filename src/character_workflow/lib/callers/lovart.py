"""Lovart 调用包装 —— 三 Skill 共用。

把 SKILL.md / references/lovart-call.md 里的 subprocess 调用代码搬到这里，
让 jobs.py 和上层 Skill 不直接拼 CLI args。
默认拉 GPT Image 2（`generate_image_gpt_image_2`）；其他模型可显式传 model 参数。

成功 → 返回 `LovartResult(output_paths=[...], raw_json={...})`
失败 → 抛 `LovartError`；超时 → 抛 `LovartTimeout`（subclass of LovartError）

Lovart CLI 安装在 ~/.claude/skills/lovart-api/，由 LOVART_CLI 环境变量覆盖。

Task 11: 顶层新增 `render(*, prompt, model, alias, output_dir, **kwargs)`，
按 alias 查 keys 注入凭证，再调内部 submit_and_wait。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_LOVART_CLI = (
    Path(__file__).resolve().parents[2] / "bin" / "lovart_wrapper.py"
)
_PROXY_ENV_KEYS = (
    "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
    "https_proxy", "http_proxy", "all_proxy",
)


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


def _command_prefix() -> list[str]:
    path = _cli_path()
    if path.suffix == ".py":
        return [sys.executable, str(path)]
    return [str(path)]


def _clean_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in _PROXY_ENV_KEYS:
        env[key] = ""
    env["NO_PROXY"] = "lovart.ai,.lovart.ai"
    env["no_proxy"] = "lovart.ai,.lovart.ai"
    env.setdefault("LOVART_FORCE_TLS12", "1")
    return env


def _build_cmd(
    *, prompt: str, model: str, output_dir: Path,
    n: int, reference_images: list[str] | None = None,
    attachments: list[str] | None = None,
) -> list[str]:
    cmd: list[str] = [
        *_command_prefix(),
        "chat",
        "--include-tools", model,
        "--output-dir", str(output_dir),
        "--json", "--download",
        "--prompt", prompt,
    ]
    refs = attachments if attachments is not None else reference_images
    if refs:
        cmd.append("--attachments")
        cmd.extend(refs)
    return cmd


def _run_json(cmd: list[str], *, timeout: float) -> dict:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_clean_env(),
        )
    except subprocess.TimeoutExpired as e:
        raise LovartTimeout(f"lovart-api timed out after {timeout}s") from e

    if result.returncode != 0:
        raise LovartError(
            f"lovart-api exit {result.returncode}: {result.stderr.strip() or result.stdout.strip()}"
        )

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise LovartError(f"unparseable output: {e}; raw={result.stdout[:200]!r}") from None


def upload_files(paths: list[str], *, timeout: float = 180.0) -> list[str]:
    """Upload local reference images through lovart-api and return CDN URLs."""
    urls: list[str] = []
    for path in paths:
        payload = _run_json(
            [*_command_prefix(), "upload", "--file", path],
            timeout=timeout,
        )
        url = payload.get("url")
        if not isinstance(url, str) or not url:
            raise LovartError(f"upload response missing url: {payload!r}")
        urls.append(url)
    return urls


def submit_and_wait(
    *, prompt: str, model: str = "generate_image_gpt_image_2",
    output_dir: Path, n: int = 1,
    reference_images: list[str] | None = None,
    attachments: list[str] | None = None,
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
        n=n, reference_images=reference_images, attachments=attachments,
    )
    payload = _run_json(cmd, timeout=timeout)

    paths = payload.get("output_paths") or payload.get("downloaded_paths")
    if paths is None:
        downloaded = payload.get("downloaded") or []
        paths = [
            item.get("local_path")
            for item in downloaded
            if isinstance(item, dict) and isinstance(item.get("local_path"), str)
        ]
    if not paths or not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        raise LovartError(f"output_paths missing or malformed in lovart-api response: {payload!r}")
    return LovartResult(output_paths=paths, raw_json=payload)


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    reference_images: list[str] | None = None,
    attachments: list[str] | None = None,
    n: int = 1,
    timeout: float = 600.0,
    **_unused,
) -> list[str]:
    """Alias-aware entrypoint used by dispatch().

    Looks up the key by alias, injects LOVART_ACCESS_KEY/LOVART_SECRET_KEY
    into os.environ, then delegates to submit_and_wait. Returns the
    resulting output_paths (list[str]).

    Raises:
        ValueError: if alias provider is not "lovart".
        LovartError / LovartTimeout: propagated from submit_and_wait.
    """
    from character_workflow.lib import keys as _keys

    key = _keys.find_by_alias(alias)
    if key is None:
        raise ValueError(f"alias not found: {alias}")
    if key.provider != "lovart":
        raise ValueError(
            f"alias {alias!r} has provider {key.provider!r}, expected 'lovart'"
        )

    out_path = Path(output_dir) if not isinstance(output_dir, Path) else output_dir

    saved_ak = os.environ.get("LOVART_ACCESS_KEY")
    saved_sk = os.environ.get("LOVART_SECRET_KEY")
    os.environ["LOVART_ACCESS_KEY"] = key.access_key
    if key.secret_key:
        os.environ["LOVART_SECRET_KEY"] = key.secret_key
    try:
        result = submit_and_wait(
            prompt=prompt,
            model=model,
            output_dir=out_path,
            n=n,
            reference_images=reference_images,
            attachments=attachments,
            timeout=timeout,
        )
    finally:
        if saved_ak is None:
            os.environ.pop("LOVART_ACCESS_KEY", None)
        else:
            os.environ["LOVART_ACCESS_KEY"] = saved_ak
        if saved_sk is None:
            os.environ.pop("LOVART_SECRET_KEY", None)
        else:
            os.environ["LOVART_SECRET_KEY"] = saved_sk

    return list(result.output_paths)
