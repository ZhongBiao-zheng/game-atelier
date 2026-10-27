"""ChatGPT subscription images, using the local Codex login and JSON edits."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import platform
import re
import subprocess
import time
from uuid import uuid4

import requests

from character_workflow.lib import chatgpt_auth, keys, net_env
from character_workflow.lib.callers import openai_image

BASE_URL = "https://chatgpt.com/backend-api/codex"
FORBIDDEN = "ChatGPT 拒绝了这次出图：套餐或工作区可能不支持出图"
# Verified with subscription generation on 2026-10-27. Desktop launchers may lack CLI PATH.
DEFAULT_CODEX_VERSION = "0.162.1"


@lru_cache(maxsize=1)
def _codex_version() -> str:
    try:
        result = subprocess.run(["codex", "--version"], capture_output=True, text=True,
                                timeout=5, check=True)
        match = re.search(r"\d+\.\d+\.\d+", result.stdout)
        if match:
            return match.group()
    except (OSError, subprocess.SubprocessError):
        pass
    return DEFAULT_CODEX_VERSION


def _headers(credentials: chatgpt_auth.Credentials) -> dict[str, str]:
    version = _codex_version()
    return {
        "Authorization": f"Bearer {credentials.access_token}",
        "chatgpt-account-id": credentials.account_id,
        "originator": "codex_cli_rs", "version": version,
        "User-Agent": f"codex_cli_rs/{version} ({platform.system()}; {platform.machine()})",
        "OpenAI-Beta": "responses=experimental", "Accept": "application/json",
        "Content-Type": "application/json",
        "x-codex-imagegen-request-id": str(uuid4()), "x-codex-image-turn-id": str(uuid4()),
    }


def _post(url: str, payload: dict, timeout) -> dict:
    credentials = chatgpt_auth.get_credentials()
    auth_recovered = False
    for attempt in range(3):
        try:
            while True:
                response = requests.post(url, json=payload, headers=_headers(credentials),
                                         timeout=timeout, allow_redirects=False)
                if response.status_code != 401:
                    break
                if auth_recovered:
                    raise chatgpt_auth.ChatGPTAuthError(chatgpt_auth.LOGIN_EXPIRED) from RuntimeError(
                        "HTTP 401")
                auth_recovered = True
                try:
                    credentials = chatgpt_auth.get_credentials(
                        rejected_access_token=credentials.access_token)
                except chatgpt_auth.ChatGPTAuthError:
                    raise chatgpt_auth.ChatGPTAuthError(chatgpt_auth.LOGIN_EXPIRED) from RuntimeError(
                        "HTTP 401")
            if response.status_code == 403:
                raise openai_image.OpenAIImageError(FORBIDDEN) from RuntimeError("HTTP 403")
            if response.status_code >= 300:
                if openai_image._is_retryable(response.status_code, response.text) and attempt < 2:
                    time.sleep(1 + attempt)
                    continue
                # Do not persist upstream bodies that could echo credentials or reference images.
                raise openai_image.OpenAIImageError(f"ChatGPT 出图失败（HTTP {response.status_code}）")
            try:
                result = response.json()
                if not isinstance(result, dict):
                    raise ValueError
                return result
            except ValueError:
                raise openai_image.OpenAIImageError("ChatGPT 出图响应非 JSON") from None
        except requests.RequestException as error:
            if not openai_image._is_pre_flight_failure(error) or attempt >= 2:
                # Preserve only safe pre-flight classification, never request/response secrets.
                cause = (requests.ConnectTimeout("connection failed")
                         if openai_image._is_pre_flight_failure(error) else None)
                raise openai_image.OpenAIImageError("ChatGPT 出图网络请求失败，请检查网络") from cause
            time.sleep(1 + attempt)
    raise openai_image.OpenAIImageError("ChatGPT 出图重试失败")


def render(*, prompt: str, model: str, alias: str, output_dir: Path | str,
           n: int = 1, timeout=net_env.DEFAULT_TIMEOUT, **kwargs) -> list[str]:
    key = keys.find_by_alias(alias)
    if key is None or key.provider != "chatgpt":
        raise ValueError("需要 ChatGPT 订阅供应商")
    if model != "gpt-image-2":
        raise ValueError("ChatGPT 订阅仅支持 GPT Image")
    if n != 1:
        raise ValueError("ChatGPT 订阅每次生成 1 张图片")
    params = kwargs.get("params") or {}
    if params.get("image_edit") or params.get("layer_decomposition"):
        raise ValueError("ChatGPT 订阅尚未开放此编辑操作")
    payload = {"model": model, "prompt": prompt, "n": 1}
    refs = openai_image._collect_ref_paths(kwargs, "chatgpt", model)
    if len(refs) > 1:
        raise ValueError("ChatGPT 订阅每次支持 1 张参考图")
    mask = kwargs.get("mask_image") or (kwargs.get("params") or {}).get("mask_image")
    if mask:
        raise ValueError("ChatGPT 订阅尚未开放蒙版编辑")
    if refs:
        payload["images"] = [{"image_url": openai_image._image_data_url(p)} for p in refs]
    # size/quality/background remain absent until real-account probes establish support.
    endpoint = "/images/edits" if refs else "/images/generations"
    result = _post(BASE_URL + endpoint, payload, timeout)
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    return openai_image._write_outputs(result, directory)
