from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib.callers import aggregator_keys, aggregator_protocols as protocols
from character_workflow.lib.callers import aggregator_refs


class AggregatorError(RuntimeError):
    pass


def _base_url(key) -> str:
    url = str(key.base_url or "").rstrip("/")
    if not url:
        raise AggregatorError("聚合 Key 缺少 base_url")
    return url


def _download_url(url: str, timeout: float = 180.0):
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    return response


def _write_image_bytes(output_dir: Path, data: bytes, index: int) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"v{index}.png"
    path.write_bytes(data)
    return str(path)


def _download_to_output(url: str, output_dir: Path, index: int) -> str:
    try:
        response = _download_url(url)
    except requests.RequestException as e:
        raise AggregatorError(f"下载上游图片失败: {e}") from e
    return _write_image_bytes(output_dir, response.content, index)


def _items_from_payload(payload: dict[str, Any]) -> list[Any]:
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        nested = data.get("data")
        if isinstance(nested, list):
            return nested
        if isinstance(nested, dict) and isinstance(nested.get("data"), list):
            return nested["data"]
    return []


def _write_outputs(payload: dict[str, Any], output_dir: Path) -> list[str]:
    paths: list[str] = []
    for item in _items_from_payload(payload):
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("b64_json"), str):
            data = base64.b64decode(item["b64_json"])
            paths.append(_write_image_bytes(output_dir, data, len(paths) + 1))
        elif isinstance(item.get("url"), str):
            paths.append(_download_to_output(item["url"], output_dir, len(paths) + 1))
    return paths


def _task_id(payload: dict[str, Any]) -> str | None:
    data = payload.get("data")
    if isinstance(data, str):
        return data
    if isinstance(data, dict) and isinstance(data.get("task_id"), str):
        return data["task_id"]
    for key in ("task_id", "id", "result", "request_id"):
        if isinstance(payload.get(key), str):
            return payload[key]
    return None


def _error_message(payload: dict[str, Any], status_code: int) -> str:
    error = payload.get("error")
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return str(error or payload.get("message") or f"上游 HTTP {status_code}")


def _post_json_or_form(
    url: str,
    *,
    api_key: str,
    json_body=None,
    data=None,
    files=None,
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    if json_body is not None:
        headers["Content-Type"] = "application/json"
        response = requests.post(url, headers=headers, json=json_body, timeout=600)
    else:
        response = requests.post(url, headers=headers, data=data, files=files, timeout=600)
    text = response.text
    try:
        payload = response.json()
    except Exception as e:
        raise AggregatorError(f"上游响应非 JSON: {text[:300]}") from e
    if not response.ok:
        raise AggregatorError(_error_message(payload, response.status_code))
    return payload


def _submit_standard_image(
    *,
    api_key: str,
    base_url: str,
    prompt: str,
    model: str,
    n: int,
    params: dict[str, Any],
) -> dict[str, Any]:
    refs = list(params.get("reference_images") or [])
    protocol = protocols.detect_image_protocol(model, params.get("param_kind"))
    if protocol == protocols.ImageProtocol.MJ:
        return _submit_mj(api_key=api_key, base_url=base_url, prompt=prompt, params=params)
    if protocol == protocols.ImageProtocol.FAL:
        return _submit_fal(
            api_key=api_key,
            base_url=base_url,
            prompt=prompt,
            model=model,
            n=n,
            params=params,
        )
    if protocol == protocols.ImageProtocol.BANANA_RATIO and not refs:
        payload = protocols.build_banana_json_payload(
            prompt=prompt,
            model=model,
            n=n,
            aspect_ratio=params.get("aspect_ratio") or params.get("ratio"),
            image_size=params.get("image_size") or params.get("resolution"),
            quality=params.get("quality"),
        )
        return _post_json_or_form(
            f"{base_url}/v1/images/generations?async=true",
            api_key=api_key,
            json_body=payload,
        )
    if protocol == protocols.ImageProtocol.BANANA_RATIO:
        fields = protocols.build_banana_json_payload(
            prompt=prompt,
            model=model,
            n=n,
            aspect_ratio=params.get("aspect_ratio") or params.get("ratio"),
            image_size=params.get("image_size") or params.get("resolution"),
            quality=params.get("quality"),
        )
        files = []
        for ref in refs:
            part = aggregator_refs.ref_to_file_part(ref)
            if part:
                files.append(("image", (part.filename, part.data, part.content_type)))
        return _post_json_or_form(
            f"{base_url}/v1/images/edits?async=true",
            api_key=api_key,
            data=fields,
            files=files,
        )

    fields = protocols.build_gpt_size_fields(
        prompt=prompt,
        model=model,
        n=n,
        aspect_ratio=params.get("aspect_ratio") or params.get("ratio"),
        image_size=params.get("image_size") or params.get("resolution"),
        size=params.get("size"),
        quality=params.get("quality"),
        refs=refs,
    )
    files = []
    for ref in refs:
        part = aggregator_refs.ref_to_file_part(ref)
        if part:
            files.append(("image", (part.filename, part.data, part.content_type)))
    if fields.needs_white_placeholder:
        files.append(("image", ("blank.png", b"\x89PNG\r\n\x1a\n", "image/png")))
    return _post_json_or_form(
        f"{base_url}/v1/images/edits?async=true",
        api_key=api_key,
        data=fields.text,
        files=files,
    )


def _mj_speed_segment(speed: str | None) -> str:
    return {
        "turbo": "mj-turbo",
        "fast": "mj-fast",
        "relax": "mj-relax",
    }.get(str(speed or "fast").lower(), "mj-fast")


def _submit_mj(
    *,
    api_key: str,
    base_url: str,
    prompt: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    speed = _mj_speed_segment(params.get("speed"))
    payload = protocols.build_mj_payload(
        prompt=prompt,
        base64_array=list(params.get("base64_array") or params.get("base64Array") or []),
        ar=params.get("aspect_ratio") or params.get("ar"),
        seed=params.get("seed"),
    )
    payload["modes"] = list(params.get("modes") or [])
    return _post_json_or_form(
        f"{base_url}/{speed}/mj/submit/imagine",
        api_key=api_key,
        json_body=payload,
    )


def _fal_endpoint(model: str, refs: list[str]) -> str:
    m = str(model or "").lower()
    if "nano-banana" in m:
        return "fal-ai/nano-banana-pro/edit"
    if refs:
        return "openai/gpt-image-2/edit"
    return "openai/gpt-image-2"


def _fix_fal_response_url(
    response_url: str | None,
    *,
    base_url: str,
    endpoint: str,
    request_id: str,
) -> str:
    if response_url:
        return response_url.replace("https://queue.fal.run", f"{base_url}/fal")
    return f"{base_url}/fal/{endpoint}/requests/{request_id}"


def _submit_fal(
    *,
    api_key: str,
    base_url: str,
    prompt: str,
    model: str,
    n: int,
    params: dict[str, Any],
) -> dict[str, Any]:
    refs = list(params.get("reference_images") or [])
    endpoint = _fal_endpoint(model, refs)
    payload: dict[str, Any] = {
        "prompt": prompt,
        "num_images": max(1, int(n or params.get("n") or 1)),
        "output_format": str(params.get("format") or "png").lower(),
    }
    if "nano-banana" in str(model).lower():
        payload["aspect_ratio"] = str(params.get("aspect_ratio") or params.get("ratio") or "auto")
        payload["resolution"] = str(params.get("resolution") or params.get("image_size") or "2K")
        payload["safety_tolerance"] = str(params.get("safety_tolerance") or "4")
    else:
        payload["quality"] = str(params.get("quality") or "medium")
        if params.get("size"):
            payload["image_size"] = params["size"]
    if refs:
        urls = []
        for ref in refs:
            uploaded = aggregator_refs.upload_ref_to_aggregator(ref, api_key=api_key, base_url=base_url)
            if uploaded:
                urls.append(uploaded)
        if urls:
            payload["image_urls"] = urls
    return _post_json_or_form(
        f"{base_url}/fal/{endpoint}",
        api_key=api_key,
        json_body=payload,
    )


def _poll_task(
    *,
    task_id: str,
    alias: str,
    output_dir: Path,
    max_polls: int,
    poll_interval: float,
) -> list[str]:
    for _ in range(max_polls):
        if poll_interval:
            time.sleep(poll_interval)
        remembered = aggregator_keys.recall_task_alias(task_id)
        key = aggregator_keys.pick_key(model_hint="", alias=remembered or alias)
        response = requests.get(
            f"{_base_url(key)}/v1/images/tasks/{task_id}",
            headers={"Authorization": f"Bearer {key.access_key}"},
            timeout=180,
        )
        try:
            payload = response.json()
        except Exception as e:
            raise AggregatorError(f"上游响应非 JSON: {response.text[:300]}") from e
        if not response.ok:
            raise AggregatorError(_error_message(payload, response.status_code))
        inner = payload.get("data") or {}
        status = str(inner.get("status") or "").lower() if isinstance(inner, dict) else ""
        if status in ("success", "completed", "done"):
            paths = _write_outputs(payload, output_dir)
            if paths:
                return paths
            raise AggregatorError("任务成功但未返回图片")
        if status in ("failure", "failed", "error"):
            reason = inner.get("fail_reason") if isinstance(inner, dict) else None
            raise AggregatorError(str(reason or "任务失败"))
    raise AggregatorError(f"任务轮询超时: {task_id}")


def _poll_mj_task(
    *,
    task_id: str,
    api_key: str,
    base_url: str,
    speed: str | None,
    output_dir: Path,
    max_polls: int,
    poll_interval: float,
) -> list[str]:
    url = f"{base_url}/{_mj_speed_segment(speed)}/mj/task/{task_id}/fetch"
    for _ in range(max_polls):
        if poll_interval:
            time.sleep(poll_interval)
        response = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=180)
        try:
            payload = response.json()
        except Exception as e:
            raise AggregatorError(f"上游响应非 JSON: {response.text[:300]}") from e
        if not response.ok:
            raise AggregatorError(_error_message(payload, response.status_code))
        status = str(payload.get("status") or "").lower()
        if status in ("success", "completed", "done"):
            image_url = payload.get("imageUrl") or payload.get("image_url")
            if isinstance(image_url, str) and image_url:
                return [_download_to_output(image_url, output_dir, 1)]
            paths = _write_outputs(payload, output_dir)
            if paths:
                return paths
            raise AggregatorError("MJ 任务成功但未返回图片")
        if status in ("failure", "failed", "error"):
            raise AggregatorError(str(payload.get("fail_reason") or payload.get("description") or "MJ 任务失败"))
    raise AggregatorError(f"MJ 任务轮询超时: {task_id}")


def _poll_fal_task(
    *,
    payload: dict[str, Any],
    api_key: str,
    base_url: str,
    endpoint: str,
    output_dir: Path,
    max_polls: int,
    poll_interval: float,
) -> list[str]:
    request_id = str(payload.get("request_id") or "")
    if not request_id:
        raise AggregatorError(f"FAL 未返回 request_id: {payload!r}")
    url = _fix_fal_response_url(
        payload.get("response_url"),
        base_url=base_url,
        endpoint=endpoint,
        request_id=request_id,
    )
    for _ in range(max_polls):
        if poll_interval:
            time.sleep(poll_interval)
        response = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=180)
        try:
            data = response.json()
        except Exception as e:
            raise AggregatorError(f"上游响应非 JSON: {response.text[:300]}") from e
        if not response.ok and data.get("status") not in ("IN_QUEUE", "IN_PROGRESS"):
            raise AggregatorError(_error_message(data, response.status_code))
        images = data.get("images")
        if isinstance(images, list) and images:
            paths = []
            for item in images:
                if isinstance(item, dict) and isinstance(item.get("url"), str):
                    paths.append(_download_to_output(item["url"], output_dir, len(paths) + 1))
            if paths:
                return paths
        status = str(data.get("status") or "").upper()
        if status in ("FAILED", "CANCELLED"):
            raise AggregatorError(str(data.get("error") or data.get("detail") or f"FAL {status}"))
    raise AggregatorError(f"FAL 任务轮询超时: {request_id}")


def render(
    *,
    prompt: str,
    model: str,
    alias: str | None,
    output_dir: Path | str,
    n: int = 1,
    params: dict[str, Any] | None = None,
    max_polls: int = 1800,
    poll_interval: float = 2.0,
    **_kwargs,
) -> list[str]:
    params = dict(params or {})
    key = aggregator_keys.pick_key(model_hint=model, alias=alias)
    out_dir = Path(output_dir)
    protocol = protocols.detect_image_protocol(model, params.get("param_kind"))
    payload = _submit_standard_image(
        api_key=key.access_key,
        base_url=_base_url(key),
        prompt=prompt,
        model=model,
        n=n,
        params=params,
    )
    paths = _write_outputs(payload, out_dir)
    if paths:
        return paths
    if protocol == protocols.ImageProtocol.MJ:
        task_id = _task_id(payload)
        if not task_id:
            raise AggregatorError(f"MJ 未返回 task_id: {payload!r}")
        aggregator_keys.remember_task_alias(task_id, key.alias)
        return _poll_mj_task(
            task_id=task_id,
            api_key=key.access_key,
            base_url=_base_url(key),
            speed=params.get("speed"),
            output_dir=out_dir,
            max_polls=max_polls,
            poll_interval=poll_interval,
        )
    if protocol == protocols.ImageProtocol.FAL:
        endpoint = _fal_endpoint(model, list(params.get("reference_images") or []))
        request_id = _task_id(payload)
        if request_id:
            aggregator_keys.remember_task_alias(request_id, key.alias)
        return _poll_fal_task(
            payload=payload,
            api_key=key.access_key,
            base_url=_base_url(key),
            endpoint=endpoint,
            output_dir=out_dir,
            max_polls=max_polls,
            poll_interval=poll_interval,
        )
    task_id = _task_id(payload)
    if not task_id:
        raise AggregatorError(f"上游未返回图片也未返回 task_id: {payload!r}")
    aggregator_keys.remember_task_alias(task_id, key.alias)
    return _poll_task(
        task_id=task_id,
        alias=key.alias,
        output_dir=out_dir,
        max_polls=max_polls,
        poll_interval=poll_interval,
    )
