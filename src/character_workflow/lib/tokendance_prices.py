"""TokenDance 价格快照：服务启动时（之后每 6 小时）从公开模型接口同步到本机。

价格以 TokenDance 公开的 `GET /portal/api/models/{slug}` 为准（币种为人民币，与火山方舟官方价一致），
只同步 keys 里配置的 TokenDance 模型。拉取失败保留上一份快照；快照里没有的模型估价为 None（未计价）。
任务的预计费用在提交 / 执行时冻结，快照之后变化不影响历史记录。
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import requests

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json

SYNC_INTERVAL_SECONDS = 6 * 3600
_TIMEOUT = (10, 15)
_log = logging.getLogger(__name__)
_cache: tuple[float, dict[str, Any]] | None = None
_worker_started = False
_worker_lock = threading.Lock()


def snapshot_path() -> Path:
    return data_root.runtime_dir() / "prices" / "tokendance.json"


def load_snapshot() -> dict[str, Any]:
    """{"synced_at": str | None, "models": {model_id: pricing}}；按文件修改时间缓存。"""
    global _cache
    path = snapshot_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {"synced_at": None, "models": {}}
    if _cache is None or _cache[0] != mtime:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"synced_at": None, "models": {}}
        if not isinstance(value, dict) or not isinstance(value.get("models"), dict):
            return {"synced_at": None, "models": {}}
        _cache = (mtime, value)
    return _cache[1]


def model_pricing(model_id: str) -> dict[str, Any] | None:
    pricing = load_snapshot()["models"].get(model_id)
    return pricing if isinstance(pricing, dict) else None


def _configured_models() -> dict[str, str]:
    """{model_id: 价格接口所在的 origin}，只取 keys 里 provider=tokendance 的模型。"""
    from character_workflow.lib import keys

    models: dict[str, str] = {}
    for key in keys.read_keys_db().keys:
        if key.provider != "tokendance":
            continue
        parsed = urlsplit(key.base_url or "https://tokendance.space")
        origin = f"{parsed.scheme or 'https'}://{parsed.hostname or 'tokendance.space'}"
        for model in key.models:
            models.setdefault(model.id, origin)
    return models


def sync() -> dict[str, Any]:
    """拉取已配置 TokenDance 模型的价格并写快照；单个模型失败时保留它的旧价格。"""
    models = _configured_models()
    if not models:
        return load_snapshot()
    previous = load_snapshot()["models"]
    synced: dict[str, Any] = {}
    failures = []
    for model_id, origin in models.items():
        # keys 里的「seedance-2.0-fast:save」这类变体按冒号前的模型 slug 查价，结果仍记在完整 ID 下。
        slug = model_id.split(":", 1)[0]
        try:
            response = requests.get(f"{origin}/portal/api/models/{quote(slug, safe='')}",
                                    timeout=_TIMEOUT)
            response.raise_for_status()
            pricing = response.json().get("pricing")
            if not isinstance(pricing, dict):
                raise ValueError("pricing missing")
            synced[model_id] = pricing
        except (requests.RequestException, ValueError) as error:
            failures.append(f"{model_id}: {error}")
            if model_id in previous:
                synced[model_id] = previous[model_id]
    if failures:
        _log.warning("TokenDance 价格同步部分失败：%s", "; ".join(failures))
    snapshot = {"synced_at": datetime.now(timezone.utc).isoformat(), "models": synced}
    atomic_write_json(snapshot_path(), snapshot)
    return snapshot


def start_background_sync() -> None:
    """进程内只起一个守护线程：立即同步一次，之后每 6 小时一次。"""
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True

    def loop() -> None:
        while True:
            try:
                sync()
            except Exception:  # noqa: BLE001 —— 同步失败不能拖垮服务，下一轮再试
                _log.exception("TokenDance 价格同步失败")
            time.sleep(SYNC_INTERVAL_SECONDS)

    threading.Thread(target=loop, name="tokendance-price-sync", daemon=True).start()
