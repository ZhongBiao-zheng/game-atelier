"""三个独立数据目录，经真实回环网关发布、浏览、使用、停止。"""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import socket
import time

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from character_workflow.lib import data_root, gateway_keys, keys, team_library
from character_workflow.lib import team_library_index as indexer
from character_workflow.lib import gateway_share_store as store, gateway_share_publisher as publisher
from viewer_server import gateway_app
from viewer_server.gateway_library_proxy import router
from viewer_server.gateway_shares import install_errors


@pytest.fixture
def trio(tmp_path, monkeypatch):
    roots = {name: tmp_path / name for name in ('host', 'publisher', 'viewer')}
    for root in roots.values():
        root.mkdir()
    current = ContextVar('share_root', default=roots['viewer'])
    monkeypatch.setattr(data_root, 'resolve_data_root', current.get)
    @contextmanager
    def at(name):
        token = current.set(roots[name])
        try:
            yield
        finally:
            current.reset(token)
    with at('host'):
        owner, owner_token = gateway_keys.create_key('分享人')
        viewer, viewer_token = gateway_keys.create_key('浏览者')
    original = gateway_app.create_gateway_app
    def factory():
        app = original()
        class Root:
            def __init__(self, app):
                self.app = app
            async def __call__(self, scope, receive, send):
                with at('host'):
                    await self.app(scope, receive, send)
        app.add_middleware(Root)
        return app
    monkeypatch.setattr(gateway_app, 'create_gateway_app', factory)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    server = gateway_app.GatewayServer(host='127.0.0.1')
    server.start(port)
    base = f'http://127.0.0.1:{port}'
    session = requests.Session()
    session.trust_env = False
    for _ in range(50):
        try:
            session.get(base + '/gateway/v1/health', timeout=1).raise_for_status()
            break
        except requests.RequestException:
            time.sleep(.05)
    for name, secret in [('publisher', owner_token), ('viewer', viewer_token)]:
        with at(name):
            keys.add_key(keys.KeySpec(alias='网关', provider='atelier', base_url=base, access_key=secret, created_at='test'))
    with at('publisher'):
        folder = roots['publisher'] / 'source'
        folder.mkdir()
        for name, color in [('one.png', 'red'), ('two.png', 'green')]:
            Image.new('RGB', (128, 64), color).save(folder / name)
        mount = team_library.mount_library(project_id='project', path=str(folder), name='成员参考', created_by='作者')
        indexer.write_index(indexer.build_index(mount))
        team_library.set_gateway_shared(mount.library_id, True)
    app = FastAPI()
    app.include_router(router)
    install_errors(app)
    def request(method, path, body=None, *, other=False, data=None):
        return session.request(method, base + '/gateway/v1/' + path,
            headers={'Authorization': 'Bearer ' + (viewer_token if other else owner_token)},
            json=body, data=data, timeout=5)
    try:
        with TestClient(app) as client:
            yield dict(roots=roots, at=at, owner=owner, viewer=viewer, request=request, mount=mount, client=client)
    finally:
        session.close()
        server.stop()


def publish(p):
    with p['at']('publisher'):
        publisher.sync_library(p['mount'].library_id)
        state = team_library.gateway_share_state()
        published = state.publishes[p['mount'].library_id]
        assert published.gateways['网关'].status == 'synced', published
        return published.share_id, f"ms_{p['owner'].id}_{published.share_id}"


def test_three_roots_incremental_content_and_host_stop(trio, monkeypatch):
    p = trio
    uploads = []
    original = publisher._request
    def track(session, provider, method, path, **kwargs):
        if '/blobs/' in path:
            uploads.append(path)
        return original(session, provider, method, path, **kwargs)
    monkeypatch.setattr(publisher, '_request', track)
    share, library = publish(p)
    assert len(uploads) == 2
    with p['at']('viewer'):
        sources = p['client'].get('/api/gateway-libraries').json()
        assert sources[0]['libraries'][0]['id'] == library
        prefix = f'/api/gateway-libraries/网关/{library}/assets'
        entries = p['client'].get(prefix).json()
        assert len(entries) == 2
        for entry in entries:
            assert entry['has_content']
            result = p['client'].get(prefix + '/' + entry['entry_id'] + '/content')
            original_file = p['roots']['publisher'] / 'source' / entry['title']
            assert result.status_code == 200
            assert hashlib.sha256(result.content).digest() == hashlib.sha256(original_file.read_bytes()).digest()
            assert result.headers['content-disposition'] == 'attachment'
        assert not (p['roots']['viewer'] / 'creation-assets').exists()
    # 请求者不看到自己的上传库；主机本机直接读取中转存储。
    assert p['request']('GET', 'libraries').json() == []
    with p['at']('host'):
        assert p['client'].get('/api/gateway-libraries').json()[0]['gateway_alias'] == '@host'
        assert p['client'].get('/api/gateway-shares').json()['size_bytes'] > 0
    uploads.clear()
    with p['at']('publisher'):
        Image.new('RGB', (128, 64), 'blue').save(p['roots']['publisher'] / 'source' / 'one.png')
        indexer.write_index(indexer.build_index(p['mount']))
    publish(p)
    assert len(uploads) == 1
    with p['at']('host'):
        assert p['client'].delete('/api/gateway-shares/' + library).status_code == 200
    with p['at']('publisher'):
        publisher.sync_library(p['mount'].library_id)
        state = team_library.gateway_share_state()
        assert p['mount'].library_id not in state.shared_library_ids
        assert state.publishes[p['mount'].library_id].gateways['网关'].error == '已被网关主机停止'
    assert p['request']('GET', f'libraries/{library}/assets', other=True).status_code == 404


def test_ownership_hash_missing_commit_and_public_whitelist(trio):
    p = trio
    share, library = publish(p)
    with p['at']('publisher'):
        manifest, files = publisher.build_manifest(p['mount'].library_id, share)
    payload = manifest.model_dump(mode='json')
    prefix = 'shares/' + share
    original = p['request']('GET', f'libraries/{library}/assets', other=True).json()
    for method, suffix in [('PUT', '/manifest'), ('DELETE', '')]:
        assert p['request'](method, prefix + suffix, payload if suffix else None, other=True).status_code == 404
    assert p['request']('PUT', prefix + '/manifest', {**payload, 'key_id': p['viewer'].id}).status_code == 422
    payload['entries'][0]['raw_path'] = '/private/image.png'
    assert p['request']('PUT', prefix + '/manifest', payload).status_code == 422
    del payload['entries'][0]['raw_path']
    payload['entries'][0]['file'] = {'sha256': 'f' * 64, 'size': 3, 'filename': 'missing.png'}
    assert p['request']('PUT', prefix + '/manifest', payload).json()['missing'] == ['f' * 64]
    assert p['request']('PUT', prefix + '/blobs/' + 'f' * 64, data=b'bad').status_code == 422
    with p['at']('host'):
        assert not store.blob_path('f' * 64).exists()
    commit = p['request']('POST', prefix + '/commit')
    assert commit.status_code == 422 and commit.json()['missing'] == ['f' * 64]
    assert p['request']('GET', f'libraries/{library}/assets', other=True).json() == original
    assert p['request']('PUT', prefix + '/blobs/' + 'f' * 64, data=b'too big').status_code == 413
    allowed = {'entry_id', 'kind', 'title', 'author', 'mime_type', 'width', 'height', 'duration_s', 'tags', 'category', 'prompt_text', 'preview_count', 'has_content'}
    assert all(set(entry) <= allowed for entry in original)
    import re
    def safe(value):
        if isinstance(value, dict):
            for k, v in value.items():
                assert not any(word in k for word in ('path', 'snapshot', 'params', 'inputs', 'key_id'))
                safe(v)
        elif isinstance(value, list):
            for item in value:
                safe(item)
        elif isinstance(value, str):
            assert not value.startswith(('/', '\\')) and not re.match(r'^[a-zA-Z]:', value)
    safe(original)
    safe(p['request']('GET', 'libraries', other=True).json())


def test_revoke_gc_preserves_other_library_references(trio):
    p = trio
    share, library = publish(p)
    with p['at']('publisher'):
        manifest, files = publisher.build_manifest(p['mount'].library_id, share)
    payload = manifest.model_dump(mode='json')
    shared_sha = payload['entries'][0]['file']['sha256']
    exclusive_sha = payload['entries'][1]['file']['sha256']
    payload['share_id'] = 'sh_222222222222'
    payload['entries'] = payload['entries'][:1]
    assert p['request']('PUT', 'shares/sh_222222222222/manifest', payload, other=True).json()['missing'] == []
    assert p['request']('POST', 'shares/sh_222222222222/commit', other=True).status_code == 200
    with p['at']('host'):
        gateway_keys.revoke_key(p['owner'].id)
        assert store.blob_path(shared_sha).exists()
        assert not store.blob_path(exclusive_sha).exists()
    assert p['request']('GET', f'libraries/{library}/assets', other=True).status_code == 404
    with p['at']('publisher'):
        publisher.sync_library(p['mount'].library_id)
        assert not team_library.shared_library_ids()


def test_offline_stop_persists_retry_and_retries(trio, monkeypatch):
    p = trio
    share, library = publish(p)
    original = publisher._request
    with p['at']('publisher'):
        team_library.set_gateway_shared(p['mount'].library_id, False)
        monkeypatch.setattr(publisher, '_request', lambda *args, **kwargs: (_ for _ in ()).throw(requests.ConnectionError()))
        publisher.sync_library(p['mount'].library_id)
        target = team_library.gateway_share_state().publishes[p['mount'].library_id].gateways['网关']
        assert target.delete_pending and target.status == 'failed'
        assert not team_library.shared_library_ids()
        monkeypatch.setattr(publisher, '_request', original)
        publisher.sync_library(p['mount'].library_id)
        assert not team_library.gateway_share_state().publishes[p['mount'].library_id].gateways['网关'].delete_pending
    assert p['request']('GET', f'libraries/{library}/assets', other=True).status_code == 404


def test_pending_references_survive_gc_and_disk_errors_are_503(trio, monkeypatch):
    p = trio
    share, library = publish(p)
    with p['at']('publisher'):
        manifest, _ = publisher.build_manifest(p['mount'].library_id, share)
    payload = manifest.model_dump(mode='json')
    payload['share_id'] = 'sh_333333333333'
    sha = payload['entries'][0]['file']['sha256']
    assert p['request']('PUT', 'shares/sh_333333333333/manifest', payload, other=True).status_code == 200
    assert p['request']('DELETE', 'shares/' + share).status_code == 200
    with p['at']('host'):
        assert store.blob_path(sha).exists()  # 暂存库尚未 commit，也受 GC 保护。
    assert p['request']('POST', 'shares/sh_333333333333/commit', other=True).status_code == 200
    def disk_full(*args, **kwargs):
        raise OSError('private disk path must not escape')
    monkeypatch.setattr(store, 'atomic_write_json', disk_full)
    response = p['request']('PUT', 'shares/sh_333333333333/manifest', payload, other=True)
    assert response.status_code == 503
    assert 'private disk' not in response.text


def test_unchanged_second_sync_does_not_open_media_or_previews(trio, monkeypatch):
    from pathlib import Path
    from character_workflow.lib import creation_assets
    from character_workflow.lib.team_library_share import share_creation_asset
    p = trio
    with p['at']('publisher'):
        folder = Path(p['mount'].mount_path)
        prompt = creation_assets.create_prompt_asset('提示词', [{'kind': 'text', 'text': '山谷'}], [])
        creation_assets.add_prompt_previews(prompt.asset_id, [((folder / 'one.png').read_bytes(), 'image/png')])
        share_creation_asset(p['mount'], asset_id=prompt.asset_id, title=prompt.title, tags=[], author='作者')
        media = creation_assets.create_media_asset_from_bytes(title='素材', body=(folder / 'two.png').read_bytes(),
            filename='stored.png', mime_type='image/png', tags=[])
        share_creation_asset(p['mount'], asset_id=media.asset_id, title=media.title, tags=[], author='作者')
        (folder / 'clip.mp4').write_bytes(b'test-video-content')
        indexer.write_index(indexer.build_index(p['mount']))
        media_paths = {path.resolve() for path in folder.rglob('*') if path.suffix in ('.png', '.mp4')}
    opened = []
    original_open = Path.open
    def track(path, *args, **kwargs):
        if path.resolve() in media_paths and (args[0] if args else kwargs.get('mode', 'r')) == 'rb':
            opened.append(path.resolve())
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', track)
    publish(p)
    assert opened
    opened.clear()
    publish(p)
    assert opened == []
    # 大小相同、mtime 不同也必须重新计算，不能上传旧摘要。
    with p['at']('publisher'):
        (folder / 'clip.mp4').write_bytes(b'next-video-content')
    publish(p)
    assert opened and set(opened) == {(folder / 'clip.mp4').resolve()}
