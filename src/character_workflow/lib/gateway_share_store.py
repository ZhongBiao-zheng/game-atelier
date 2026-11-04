"""成员共享唯一写入者。与密钥撤销共用锁，暂存清单也参与引用计数。"""
from __future__ import annotations

import re
import shutil
import tempfile
from collections import Counter
from pathlib import Path

from character_workflow.lib import data_root, gateway_keys
from character_workflow.lib.atomic_io import atomic_write_json, atomic_write_text, _replace_with_retry
from character_workflow.lib.gateway_share_models import (
    MEMBER_LIBRARY_PATTERN, SHARE_ID_PATTERN, SHA_PATTERN, SharedLibraryManifest,
)


class ShareError(Exception):
    def __init__(self, status: int, detail: str, missing=None):
        self.status, self.detail, self.missing = status, detail, missing


def root() -> Path:
    return data_root.resolve_data_root() / 'gateway-shares'


def references(manifest):
    return {b.sha256: b.size for e in manifest.entries for b in [*e.previews, *([e.file] if e.file else [])]}


def _read(path):
    return SharedLibraryManifest.model_validate_json(path.read_text(encoding='utf-8'))


def _owner(key_id, share_id):
    if not re.fullmatch(SHARE_ID_PATTERN, share_id):
        raise ShareError(422, '共享标识不合法')
    config = gateway_keys._read_config_locked()
    if not any(k.id == key_id and not k.revoked_at for k in config.keys):
        raise ShareError(404, '已停止共享')
    for section in ('libraries', 'pending', 'stopped'):
        if any(p.parent.name != key_id for p in (root() / section).glob(f'*/{share_id}.json')):
            raise ShareError(404, '共享库不存在')
    if (root() / 'stopped' / key_id / f'{share_id}.json').exists():
        raise ShareError(404, '已停止共享')


def _path(section, key_id, share_id):
    return root() / section / key_id / f'{share_id}.json'


def _missing(manifest):
    return [sha for sha, size in references(manifest).items()
            if not (root() / 'blobs' / sha).is_file() or (root() / 'blobs' / sha).stat().st_size != size]


def stage(key_id, share_id, payload):
    manifest = SharedLibraryManifest.model_validate(payload)
    if manifest.share_id != share_id:
        raise ShareError(422, '共享标识不一致')
    with gateway_keys._lock():
        _owner(key_id, share_id)
        atomic_write_json(_path('pending', key_id, share_id), manifest.model_dump(mode='json'))
        return _missing(manifest)


def upload_expected(key_id, share_id, sha):
    if not re.fullmatch(SHA_PATTERN, sha):
        raise ShareError(422, '文件摘要不合法')
    with gateway_keys._lock():
        _owner(key_id, share_id)
        path = _path('pending', key_id, share_id)
        if not path.exists() or sha not in references(_read(path)):
            raise ShareError(404, '待上传文件不存在')
        return references(_read(path))[sha]


def temporary_upload():
    folder = root() / 'uploads'
    folder.mkdir(parents=True, exist_ok=True)
    return tempfile.NamedTemporaryFile(dir=folder, delete=False)


def finish_upload(key_id, share_id, sha, temp, actual_sha, size):
    with gateway_keys._lock():
        _owner(key_id, share_id)
        pending = _path('pending', key_id, share_id)
        expected = references(_read(pending)).get(sha) if pending.exists() else None
        if expected is None:
            raise ShareError(404, '待上传文件不存在')
        if size != expected or sha != actual_sha:
            raise ShareError(422, '文件摘要或大小不一致')
        target = root() / 'blobs' / sha
        target.parent.mkdir(parents=True, exist_ok=True)
        _replace_with_retry(Path(temp), target)


def _gc():
    used = set()
    for section in ('libraries', 'pending'):
        for path in (root() / section).glob('*/*.json'):
            used.update(references(_read(path)))
    for path in (root() / 'blobs').glob('*'):
        if path.name not in used:
            path.unlink(missing_ok=True)


def commit(key_id, share_id):
    with gateway_keys._lock():
        _owner(key_id, share_id)
        pending = _path('pending', key_id, share_id)
        if not pending.exists():
            raise ShareError(404, '待发布清单不存在')
        manifest = _read(pending)
        missing = _missing(manifest)
        if missing:
            raise ShareError(422, '文件尚未上传完整', missing)
        atomic_write_json(_path('libraries', key_id, share_id), manifest.model_dump(mode='json'))
        pending.unlink()
        _gc()


def delete(key_id, share_id, *, stopped=False):
    with gateway_keys._lock():
        _owner(key_id, share_id)
        if stopped:
            atomic_write_text(_path('stopped', key_id, share_id), '{}')
        for section in ('libraries', 'pending'):
            _path(section, key_id, share_id).unlink(missing_ok=True)
        _gc()


def revoke_owner_locked(key_id):
    """调用方已持 gateway lock；写入撤销状态后再清理文件。"""
    for section in ('libraries', 'pending', 'stopped'):
        folder = root() / section / key_id
        if folder.exists():
            shutil.rmtree(folder)
    _gc()


def split_id(library_id):
    if not re.fullmatch(MEMBER_LIBRARY_PATTERN, library_id):
        raise ShareError(404, '共享库不存在')
    return library_id[3:15], library_id[16:]


def get(library_id):
    key_id, share_id = split_id(library_id)
    with gateway_keys._lock():
        _owner(key_id, share_id)
        path = _path('libraries', key_id, share_id)
        if not path.exists():
            raise ShareError(404, '已停止共享')
        return _read(path)


def list_libraries(exclude_key=None, *, admin=False):
    with gateway_keys._lock():
        names = {k.id: k.name for k in gateway_keys._read_config_locked().keys if not k.revoked_at}
        result = []
        for path in (root() / 'libraries').glob('*/*.json'):
            key_id = path.parent.name
            if key_id == exclude_key or key_id not in names:
                continue
            m = _read(path)
            if _path('stopped', key_id, m.share_id).exists():
                continue
            row = dict(id=f'ms_{key_id}_{m.share_id}', name=m.name,
                       owner_name=m.owner_name or names[key_id], updated_at=m.updated_at,
                       counts=dict(Counter(e.kind for e in m.entries)))
            if admin:
                row['size_bytes'] = sum(references(m).values())
            result.append(row)
        return result


def disk_usage():
    with gateway_keys._lock():
        return sum(p.stat().st_size for p in (root() / 'blobs').glob('*'))


def entry(library_id, entry_id):
    m = get(library_id)
    found = next((e for e in m.entries if e.entry_id == entry_id), None)
    if found is None:
        raise ShareError(404, '条目不存在')
    return found


def blob_path(sha):
    if not re.fullmatch(SHA_PATTERN, sha):
        raise ShareError(404, '文件不存在')
    return root() / 'blobs' / sha
