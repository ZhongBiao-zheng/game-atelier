"""本机共享发布：清单 → 缺失文件 → 提交；停止请求先落盘，再尝试联网。"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

import requests
from character_workflow.lib import data_root, gateway_keys, keys, net_env, team_library as libraries
from character_workflow.lib import team_library_index as indexer
from character_workflow.lib.callers.atelier_gateway import _session
from character_workflow.lib.file_lock import try_file_lock
from character_workflow.lib.gateway_share_models import (
    GatewayLibraryPublish, GatewayPublishTarget, SharedLibraryManifest,
)

_executor: ThreadPoolExecutor | None = None
_guard = threading.Lock()
_scheduled: set[str] = set()
_dirty: set[str] = set()


def providers():
    return [k for k in keys.read_keys_db().keys if k.provider == 'atelier' and k.enabled and k.base_url]


def _now():
    return datetime.now(timezone.utc).isoformat()


@lru_cache(maxsize=4096)
def _uncatalogued_digest(path: Path, size: int, mtime_ns: int, preview_json: str | None):
    """没有索引摘要的文件按身份缓存；效果图校验与摘要一起失效。"""
    with path.open('rb') as source:
        if preview_json is None:
            sha = hashlib.file_digest(source, 'sha256').hexdigest()
        else:
            from character_workflow.lib.creation_assets import PROMPT_PREVIEW_MAX_BYTES, validate_prompt_preview
            from character_workflow.lib.schemas import PromptPreviewImage
            body = source.read(PROMPT_PREVIEW_MAX_BYTES + 1)
            validate_prompt_preview(PromptPreviewImage.model_validate_json(preview_json), body)
            sha = hashlib.sha256(body).hexdigest()
    current = path.stat()
    if (current.st_size, current.st_mtime_ns) != (size, mtime_ns):
        raise ValueError('文件正在变化，请重新扫描')
    return sha


def build_manifest(library_id, share_id):
    # 与主机直读共享使用同一路径闸门，输出只由公开模型构造。
    from viewer_server.gateway_libraries import available_entries, local_content, public_id, _safe_path
    mount = libraries.get_mount(library_id)
    entries, files = [], {}
    def blob(path, known_sha=None, preview=None):
        stat = path.stat()
        sha = known_sha or _uncatalogued_digest(path.resolve(), stat.st_size, stat.st_mtime_ns,
            preview.model_dump_json() if preview else None)
        files[sha] = path
        return {'sha256': sha, 'size': stat.st_size}
    for e in available_entries(mount):
        row = dict(entry_id=public_id(e), kind=e.kind, title=e.title, author=e.author,
                   mime_type=e.mime_type, tags=e.tags, category=e.category)
        if e.kind == 'prompt':
            row['prompt_text'] = e.prompt_text
            folder = indexer.shared_asset_dir(mount, e)
            # 缓存命中不再读图；文件或登记信息变化时重新验证内容与尺寸。
            row['previews'] = [blob(_safe_path(mount, str((folder / 'previews' / p.file).relative_to(Path(mount.mount_path).resolve()))), preview=p) for p in e.preview_images]
        else:
            path = local_content(mount, e)
            row['file'] = {**blob(path, known_sha=e.sha256), 'filename': path.name}
        entries.append(row)
    profile = libraries.read_profile()
    return SharedLibraryManifest.model_validate(dict(share_id=share_id, name=mount.name,
        owner_name=profile.display_name if profile else '', updated_at=_now(), entries=entries)), files


def _target(library_id, alias, **patch):
    def update(state):
        publish = state.publishes.get(library_id)
        if publish and alias in publish.gateways:
            target = publish.gateways[alias]
            for name, value in patch.items():
                setattr(target, name, value)
    libraries.mutate_gateway_state(update)


class HostStopped(Exception):
    pass


class SyncRejected(ValueError):
    pass


def _failure_reason(error):
    if isinstance(error, SyncRejected):
        return str(error)
    if isinstance(error, requests.Timeout):
        return '连接或上传超时，请稍后重试'
    if isinstance(error, requests.RequestException):
        return '无法连接网关，请检查网关地址和网络'
    if isinstance(error, OSError):
        return '读取团队库文件失败，请检查目录是否可达'
    return '共享清单或文件格式不合法，请重新扫描团队库'


def _request(session, provider, method, path, **kwargs):
    host = urlparse(provider.base_url).hostname
    net_env.configure_proxy_bypass((host,) if host else ())
    response = session.request(method, provider.base_url.rstrip('/') + '/gateway/v1/shares/' + path,
        headers={'Authorization': f'Bearer {provider.access_key}'}, timeout=net_env.DEFAULT_TIMEOUT,
        allow_redirects=False, **kwargs)
    if response.status_code in (401, 403, 404):
        response.close()
        raise HostStopped()
    if not 200 <= response.status_code < 300:
        response.close()
        raise SyncRejected(f'网关拒绝同步（HTTP {response.status_code}）')
    return response


def sync_library(library_id):
    with try_file_lock(data_root.runtime_dir() / 'gateway-share-sync' / f'{library_id}.lock') as acquired:
        if not acquired:
            return
        configured = {p.alias: p for p in providers()}
        state = libraries.gateway_share_state()
        enabled = library_id in libraries.shared_library_ids()
        host = gateway_keys.read_config().enabled
        previous = state.publishes.get(library_id)
        if previous:
            for alias, target in previous.gateways.items():
                if not target.delete_pending:
                    continue
                provider = configured.get(alias)
                if provider is None:
                    continue
                try:
                    with _session() as session:
                        try:
                            with _request(session, provider, 'DELETE', previous.share_id):
                                pass
                        except HostStopped:
                            pass
                    _target(library_id, alias, delete_pending=False, status='stopped', error=None)
                except (requests.RequestException, ValueError, OSError):
                    _target(library_id, alias, status='failed', error='连接失败，停止请求等待重试')
            state = libraries.gateway_share_state()
            if any(t.delete_pending for t in state.publishes[library_id].gateways.values()):
                return
        if enabled and not host:
            def prepare(s):
                if library_id not in s.shared_library_ids:
                    return
                previous = s.publishes.get(library_id)
                if previous is None or any(t.status == 'stopped' for t in previous.gateways.values()):
                    previous = GatewayLibraryPublish(share_id='sh_' + secrets.token_hex(6))
                    s.publishes[library_id] = previous
                for alias in configured:
                    previous.gateways.setdefault(alias, GatewayPublishTarget())
            state = libraries.mutate_gateway_state(prepare)
        publish = state.publishes.get(library_id)
        if publish is None:
            return
        manifest, files = None, {}
        for alias, target in publish.gateways.items():
            provider = configured.get(alias)
            if provider is None:
                _target(library_id, alias, status='failed', error='网关供应商不可用')
                continue
            current = libraries.gateway_share_state()
            deleting = (target.delete_pending or library_id not in current.shared_library_ids or host)
            if deleting and target.status == 'stopped' and not target.delete_pending:
                continue
            try:
                with _session() as session:
                    if deleting:
                        try:
                            with _request(session, provider, 'DELETE', publish.share_id):
                                pass
                        except HostStopped:
                            pass
                        _target(library_id, alias, delete_pending=False, status='stopped', error=None)
                        continue
                    _target(library_id, alias, status='syncing', error=None, uploaded=0, total=0)
                    if manifest is None:
                        manifest, files = build_manifest(library_id, publish.share_id)
                    with _request(session, provider, 'PUT', publish.share_id + '/manifest', json=manifest.model_dump(mode='json')) as response:
                        missing = response.json()['missing']
                    if not isinstance(missing, list) or any(sha not in files for sha in missing):
                        raise ValueError('网关返回了无效文件清单')
                    _target(library_id, alias, total=len(missing))
                    for n, sha in enumerate(missing):
                        if library_id not in libraries.shared_library_ids():
                            break
                        with files[sha].open('rb') as source, _request(session, provider, 'PUT', publish.share_id + '/blobs/' + sha, data=source):
                            pass
                        _target(library_id, alias, uploaded=n + 1)
                    if library_id not in libraries.shared_library_ids():
                        with _request(session, provider, 'DELETE', publish.share_id):
                            pass
                        _target(library_id, alias, delete_pending=False, status='stopped')
                        continue
                    with _request(session, provider, 'POST', publish.share_id + '/commit'):
                        pass
                    _target(library_id, alias, status='synced', synced_at=_now(), error=None)
            except HostStopped:
                libraries.set_gateway_shared(library_id, False)
                _target(library_id, alias, status='stopped', error='已被网关主机停止', delete_pending=False)
                schedule(library_id)
            except (requests.RequestException, OSError, ValueError, KeyError) as error:
                _target(library_id, alias, status='failed', error=_failure_reason(error))


def schedule(library_id):
    """只在服务生命周期内启动后台发布；重复扫描合并，但不会丢掉进行中的更新。"""
    with _guard:
        if _executor is None:
            return
        if library_id in _scheduled:
            _dirty.add(library_id)
            return
        _scheduled.add(library_id)
        _executor.submit(_run, library_id)


def _run(library_id):
    while True:
        try:
            sync_library(library_id)
        except Exception:
            logging.getLogger(__name__).warning('共享同步未完成，下次周期重试')
        with _guard:
            if library_id in _dirty:
                _dirty.discard(library_id)
            else:
                _scheduled.discard(library_id)
                return


def schedule_all():
    state = libraries.gateway_share_state()
    for library_id in set(state.shared_library_ids) | set(state.publishes):
        schedule(library_id)


async def run_periodic():
    global _executor
    _executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='gateway-share')
    try:
        while True:
            await asyncio.to_thread(schedule_all)
            await asyncio.sleep(600)
    finally:
        with _guard:
            executor, _executor = _executor, None
        if executor:
            await asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True)
