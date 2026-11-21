"""TokenDance 价格快照：服务启动时（之后每 6 小时）从公开模型接口同步到本机。

价格以 TokenDance 公开的 `GET /portal/api/models/{slug}` 为准（币种为人民币，与火山方舟官方价一致），
只同步 keys 里配置的 TokenDance 模型。拉取失败保留上一份快照；快照里没有的模型估价为 None（未计价）。
运行中新加到供应商的模型不等下一轮全量同步：保存供应商后在后台补拉（`start_missing_sync`），
任务冻结预计费用前再同步补拉一次（`ensure_priced`）。
任务的预计费用在提交 / 执行时冻结，快照之后变化不影响历史记录。
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import requests

from character_workflow.lib.periodic_sync import PeriodicSync
from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry

SYNC_INTERVAL_SECONDS = 6 * 3600
# 补拉失败（上游没有这个模型、网络不通）后多久内不再为同一模型重试，避免每个任务都等一次超时。
MISSING_RETRY_SECONDS = 600
_TIMEOUT = (10, 15)
_log = logging.getLogger(__name__)
_cache: tuple[float, dict[str, Any]] | None = None
_worker = PeriodicSync("tokendance-price-sync")
stop_background_sync = _worker.stop
# 全量同步与补拉都是「读快照 → 合并 → 写快照」，串行执行才不会互相覆盖。
_sync_lock = threading.Lock()
_missing_attempts: dict[str, float] = {}


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
            value = json.loads(read_text_with_retry(path))
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


def _fetch_pricing(origin: str, model_id: str) -> dict[str, Any]:
    # keys 里的「seedance-2.0-fast:save」这类变体按冒号前的模型 slug 查价，结果仍记在完整 ID 下。
    slug = model_id.split(":", 1)[0]
    response = requests.get(f"{origin}/portal/api/models/{quote(slug, safe='')}", timeout=_TIMEOUT)
    response.raise_for_status()
    pricing = response.json().get("pricing")
    if not isinstance(pricing, dict):
        raise ValueError("pricing missing")
    return pricing


def _pull(models: dict[str, str]) -> tuple[dict[str, Any], list[str]]:
    pulled: dict[str, Any] = {}
    failures = []
    for model_id, origin in models.items():
        try:
            pulled[model_id] = _fetch_pricing(origin, model_id)
        except (requests.RequestException, ValueError) as error:
            failures.append(f"{model_id}: {error}")
    if failures:
        _log.warning("TokenDance 价格同步部分失败：%s", "; ".join(failures))
    return pulled, failures


def _write(models: dict[str, Any]) -> dict[str, Any]:
    snapshot = {"synced_at": datetime.now(timezone.utc).isoformat(), "models": models}
    atomic_write_json(snapshot_path(), snapshot)
    return snapshot


def sync() -> dict[str, Any]:
    """拉取已配置 TokenDance 模型的价格并写快照；单个模型失败时保留它的旧价格。"""
    models = _configured_models()
    if not models:
        return load_snapshot()
    with _sync_lock:
        previous = load_snapshot()["models"]
        pulled, _ = _pull(models)
        synced = {model_id: pulled.get(model_id, previous.get(model_id))
                  for model_id in models if model_id in pulled or model_id in previous}
        return _write(synced)


def sync_missing(*, retry_failed: bool = True) -> dict[str, Any]:
    """只补拉已配置、快照里还没有的模型，合并进现有快照；其余模型的价格不动。

    retry_failed=False 时，最近 MISSING_RETRY_SECONDS 内补拉失败过的模型先跳过。
    """
    with _sync_lock:
        snapshot = load_snapshot()
        now = time.monotonic()
        missing = {
            model_id: origin for model_id, origin in _configured_models().items()
            if model_id not in snapshot["models"]
            and (retry_failed or now - _missing_attempts.get(model_id, -math.inf)
                 >= MISSING_RETRY_SECONDS)
        }
        if not missing:
            return snapshot
        pulled, _ = _pull(missing)
        for model_id in missing:
            if model_id in pulled:
                _missing_attempts.pop(model_id, None)
            else:
                _missing_attempts[model_id] = now
        if not pulled:
            return snapshot
        return _write({**snapshot["models"], **pulled})


def ensure_priced(model_id: str) -> dict[str, Any] | None:
    """任务冻结预计费用前调用：快照里没有这个模型就当场补拉一次（失败后冷却期内不再等）。"""
    pricing = model_pricing(model_id)
    if pricing is None:
        try:
            sync_missing(retry_failed=False)
        except Exception:  # noqa: BLE001 —— 价格补拉失败只影响估价，不能拖垮任务
            _log.exception("TokenDance 价格补拉失败")
        pricing = model_pricing(model_id)
    return pricing


def start_missing_sync() -> None:
    """供应商保存后在后台补拉新模型的价格，不阻塞保存请求。"""
    def run() -> None:
        try:
            sync_missing()
        except Exception:  # noqa: BLE001
            _log.exception("TokenDance 价格补拉失败")

    threading.Thread(target=run, name="tokendance-price-missing", daemon=True).start()


def start_background_sync() -> None:
    """进程内只起一个守护线程：立即同步一次，之后每 6 小时一次。"""
    _worker.start(sync, SYNC_INTERVAL_SECONDS, _log, "TokenDance 价格同步失败")
