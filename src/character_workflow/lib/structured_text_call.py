"""调一次对话模型拿结构化输出，并把这次调用记进用量。

「AI 帮我配置」（http_protocol_assist）与分镜插件的剧本解析（plugins/storyboard/server/parse.py）共用。
调用规则只有一套：不带 tools、不重试、失败也记账；经局域网网关的文本模型自动走网关。
任务记成 namespace=assist 的文本任务。画布里发起的调用把项目 id 写在 params.assist_project_id，
用量页据此归到那个项目（Job 的 canvas_project_id 只允许 namespace=canvas 使用）。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from character_workflow.lib import keys
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

JOB_NAMESPACE = "assist"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def text_models() -> list[tuple[keys.KeySpec, keys.ModelSpec]]:
    from character_workflow.lib.callers.openai_text import supports_model

    return [(key, model) for key in keys.read_keys_db().keys if key.enabled
            for model in key.models
            if model.modality == "text" and supports_model(key, model)]


def find_text_model(alias: str, model_id: str) -> tuple[keys.KeySpec, keys.ModelSpec] | None:
    return next(((key, model) for key, model in text_models()
                 if key.alias == alias and model.id == model_id), None)


def failure_reason(raw: str, error: BaseException | None = None) -> str:
    """对话模型调用失败的中文原因。欠费排在 403 前面：方舟欠费回的就是 403 AccountOverdueError。

    `error` 是原始异常：经局域网网关、主机正在更新时按类型直接给「网关正在更新，请稍后重试」。"""
    from character_workflow.lib.gateway_text_wait import updating_message

    from character_workflow.lib.llm_protocols import mismatch_hint

    if (updating := updating_message(error)) is not None:
        return updating
    if (hint := mismatch_hint(raw)) is not None:
        return hint
    low = raw.lower()
    if any(word in low for word in ("accountoverdue", "overdue", "insufficient", "quota",
                                     "balance", "余额", "欠费", "额度")):
        return "对话模型的账号欠费或余额不足，请到该厂商充值后重试"
    if any(word in low for word in ("401", "403", "unauthorized", "forbidden", "invalid api key",
                                     "invalid_api_key", "authentication", "permission")):
        return "对话模型的密钥无效或没有权限，请在供应商里检查密钥与模型开通情况"
    if "429" in low or "rate limit" in low or "too many requests" in low or "ratelimit" in low:
        return "对话模型请求太频繁或达到限额，请稍后再试"
    if "timed out" in low or "timeout" in low:
        return "对话模型响应超时，可以缩短内容或换一个更快的模型后再试"
    if any(word in low for word in ("connection", "resolve", "proxy", "ssl", "max retries")):
        return "连不上对话模型的服务地址，请检查网络、代理或供应商的请求地址"
    return "对话模型调用失败"


def usage_of(body: Any) -> tuple[int | None, int | None]:
    usage = body.get("usage") if isinstance(body, dict) else None
    if not isinstance(usage, dict):
        return None, None
    first = usage.get("prompt_tokens", usage.get("input_tokens"))
    second = usage.get("completion_tokens", usage.get("output_tokens"))
    if all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (first, second)):
        return first, second
    return None, None


def call_model(key: keys.KeySpec, model: keys.ModelSpec, system: str, user: str, *,
               max_output_tokens: int, timeout: tuple[float, float]
               ) -> tuple[str, int | None, int | None]:
    """调一次对话模型，不带 tools、不重试。返回 (输出文本, 输入 token, 输出 token)。"""
    from character_workflow.lib.callers.openai_compat import key_api_root
    from character_workflow.lib.callers.openai_text import (
        _content_text, _post_json, _response_text, chat_completion,
    )

    gateway = key.alias if key.provider == "atelier" else None
    if model.protocol == "openai-responses":
        payload: dict[str, Any] = {"model": model.id, "instructions": system, "input": user,
                                   "max_output_tokens": max_output_tokens}
        body = _post_json(url=f"{key_api_root(key)}/responses", access_key=key.access_key,
                          payload=payload, timeout=timeout, gateway_alias=gateway)
        text = _response_text(body)
    else:
        payload = {"model": model.id, "stream": False, "max_tokens": max_output_tokens,
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": user}]}
        body = chat_completion(key, model.protocol, payload, timeout=timeout,
                               gateway_alias=gateway)
        choices = body.get("choices") if isinstance(body, dict) else None
        text = _content_text(choices[0]) if isinstance(choices, list) and choices else None
    tokens_in, tokens_out = usage_of(body)
    return text or "", tokens_in, tokens_out


def cost_of(key: keys.KeySpec, model_id: str, tokens_in: int | None,
            tokens_out: int | None) -> float | None:
    from character_workflow.lib.generation_pricing import estimate_text_cost_cny

    if tokens_in is None or tokens_out is None:
        return None
    return estimate_text_cost_cny(model_id, tokens_in, tokens_out, key=key)


def record_job(key: keys.KeySpec, model: keys.ModelSpec, *, prompt: str, started: str,
               cost: float | None, error: str | None, project_id: str | None = None) -> str:
    """记一条任务。prompt 只写一句说明，不放资料原文。"""
    from character_workflow.lib.jobs import new_job_id, save_job

    extra = {"assist_project_id": project_id} if project_id else {}
    job = Job(
        job_id=new_job_id(), character_id=key.alias, prompt=prompt,
        submitted_at=started, completed_at=now(), model=model.id,
        params=JobParams(estimated_cost_cny=cost, **extra), output_paths=[],
        status=JobStatus.FAILED if error else JobStatus.DONE, error=error,
        kind=JobKind.TEXT, namespace=JOB_NAMESPACE, alias=key.alias, provider=key.provider,
    )
    return save_job(job).job_id
