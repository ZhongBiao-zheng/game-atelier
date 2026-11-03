"""两个独立 data root、真实回环网关 + 成员本机代理；不调用厂商。"""
from contextlib import contextmanager
from contextvars import ContextVar
from io import BytesIO
from pathlib import Path
import re
import socket
import time

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from character_workflow.lib import creation_assets, data_root, gateway_keys, keys, team_library
from character_workflow.lib import team_library_index as idx
from character_workflow.lib.schemas import TEAM_ASSET_ID_PATTERN, GenerationRecipe
from character_workflow.lib.team_library_share import share_creation_asset
from viewer_server import gateway_app
from viewer_server.gateway_library_proxy import router


@pytest.fixture
def pair(tmp_path, monkeypatch):
    host, member = tmp_path / 'host', tmp_path / 'member'
    host.mkdir()
    member.mkdir()
    root = ContextVar('gateway_test_root', default=member)
    monkeypatch.setattr(data_root, 'resolve_data_root', lambda: root.get())

    @contextmanager
    def at_host():
        token = root.set(host)
        try:
            yield
        finally:
            root.reset(token)

    with at_host():
        folder = host / 'team'
        folder.mkdir()
        Image.new('RGB', (1600, 900), 'red').save(folder / 'scene.png')
        (folder / 'clip.mp4').write_bytes(b'private original video')
        mount = team_library.mount_library(project_id='host-project', path=str(folder), name='画面参考', created_by='林晓')
        team_library.write_profile('林晓')
        prompt = creation_assets.create_prompt_asset('夕照', [{'kind': 'text', 'text': '山谷夕照'}], ['场景'])
        creation_assets.add_prompt_previews(prompt.asset_id, [((folder / 'scene.png').read_bytes(), 'image/png')])
        share_creation_asset(mount, asset_id=prompt.asset_id, title=prompt.title, tags=[], author='林晓')
        media = creation_assets.store_media_blob((folder / 'scene.png').read_bytes(), 'scene.png', 'image/png')
        generated = creation_assets.create_generation_asset(title='生成参考', tags=[], media=media,
            snapshot=GenerationRecipe(mode='image', model='private-model', final_prompt='private prompt',
                params={'seed': 12345, 'size': '1024x1024'}, submitted_at='2026-11-03T00:00:00Z'))
        share_creation_asset(mount, asset_id=generated.asset_id, title=generated.title, tags=[], author='林晓')
        idx.write_index(idx.build_index(mount))
        team_library.set_gateway_shared(mount.library_id, True)
        record, secret = gateway_keys.create_key('成员', None)

    original_factory = gateway_app.create_gateway_app
    def factory():
        app = original_factory()
        class HostRoot:
            def __init__(self, app):
                self.app = app
            async def __call__(self, scope, receive, send):
                with at_host():
                    await self.app(scope, receive, send)
        app.add_middleware(HostRoot)
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
    keys.add_key(keys.KeySpec(alias='同事', provider='atelier', base_url=base, access_key=secret, created_at='test'))
    app = FastAPI()
    app.include_router(router)
    try:
        with TestClient(app) as client:
            yield dict(client=client, base=base, session=session, secret=secret, record=record, host=host,
                       member=member, mount=mount, at_host=at_host, app=factory())
    finally:
        server.stop()
        session.close()


def test_two_roots_open_browse_close_and_no_originals(pair):
    p = pair
    client, lib = p['client'], p['mount'].library_id
    discovery = client.get('/api/gateway-libraries').json()
    assert discovery[0]['libraries'][0]['id'] == lib
    assert discovery[0]['owner_name'] == '林晓'
    assert not discovery[0]['unreachable']
    prefix = f'/api/gateway-libraries/同事/{lib}/assets'
    result = client.get(prefix)
    assert result.status_code == 200
    entries = result.json()
    assert len(entries) == 4
    assert "private-model" not in result.text and "private prompt" not in result.text and "12345" not in result.text
    allowed = {'entry_id', 'kind', 'title', 'author', 'mime_type', 'width', 'height', 'duration_s', 'tags', 'category', 'prompt_text', 'preview_count'}
    assert all(set(e) <= allowed and re.fullmatch(TEAM_ASSET_ID_PATTERN, e['entry_id']) for e in entries)
    def no_paths(value):
        if isinstance(value, dict):
            for k, v in value.items():
                assert not any(word in k for word in ('path', 'snapshot', 'params', 'inputs', 'source_job'))
                no_paths(v)
        elif isinstance(value, list):
            for v in value:
                no_paths(v)
        elif isinstance(value, str):
            assert not value.startswith(('/', '\\')) and not re.match(r'^[A-Za-z]:', value)
    no_paths([discovery, entries])
    assert str(p['host']) not in result.text and p['secret'] not in result.text
    image = next(e for e in entries if e['mime_type'] == 'image/png')
    video = next(e for e in entries if e['mime_type'] == 'video/mp4')
    prompt = next(e for e in entries if e['kind'] == 'prompt')
    assert prompt['prompt_text'] == '山谷夕照' and prompt['preview_count'] == 1
    urls = [prefix + f"/{image['entry_id']}/thumb?w=1024", prefix + f"/{prompt['entry_id']}/previews/0/thumb"]
    for url in urls:
        response = client.get(url)
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'private, max-age=60'
        with Image.open(BytesIO(response.content)) as im:
            assert im.format == 'WEBP' and max(im.size) <= 1024
        assert response.content != (p['host'] / 'team' / 'scene.png').read_bytes()
    assert client.get(prefix + f"/{video['entry_id']}/thumb").status_code == 404
    assert client.get(prefix + f"/{prompt['entry_id']}/previews/8/thumb").status_code == 404
    assert not (p['member'] / '.runtime' / 'team-libraries').exists()
    assert team_library.list_mounts() == []  # 成员根与主机根确实隔离。
    headers = {'Authorization': 'Bearer ' + p['secret']}
    remote = p['base'] + f'/gateway/v1/libraries/{lib}/assets'
    for suffix in ('content', 'raw', 'download', 'adopt'):
        assert p['session'].get(remote + f"/{image['entry_id']}/{suffix}", headers=headers).status_code == 404
    assert p['session'].get(remote).status_code == 401
    assert p['session'].get(remote + '/raw_any/thumb', headers=headers).status_code == 404
    assert client.get(urls[0].replace('1024', '2048')).status_code == 422
    for route in p['app'].routes:
        if route.path.startswith('/gateway/v1/libraries'):
            assert route.methods == {'GET'}
    with p['at_host']():
        team_library.set_gateway_shared(lib, False)
    # 即使主机已有缩略图缓存，关共享后的列表与图像请求都立即 404。
    assert client.get(prefix).status_code == 404
    for url in urls:
        assert client.get(url).status_code == 404
    assert client.get('/api/gateway-libraries').json()[0]['libraries'] == []


def test_revoked_key_unreachable_and_unmount_clears_share(pair):
    p = pair
    with p['at_host']():
        gateway_keys.revoke_key(p['record'].id)
    assert p['client'].get('/api/gateway-libraries').json()[0]['unreachable']
    with p['at_host']():
        team_library.unmount_library(p['mount'].library_id, 'host-project')
        assert not team_library.shared_library_ids()
        assert 'shared_library_ids' in (p['host'] / '.config/team-library-gateway-share.json').read_text()


def test_casefold_hidden_and_symlink_paths_rejected_even_with_cached_index(pair):
    p = pair
    with p['at_host']():
        mount = p['mount']
        index = idx.read_index(mount.library_id)
        original = next(e for e in index.entries if e.kind == 'raw' and e.mime_type == 'image/png')
        folder = Path(mount.mount_path)
        for name in ('SHARED', '.CONFIG'):
            (folder / name).mkdir(exist_ok=True)
            (folder / name / 'private.png').write_bytes((folder / 'scene.png').read_bytes())
        for relative in ('SHARED/private.png', '.CONFIG/private.png', '../secret.png'):
            index.entries.append(original.model_copy(update={'id': idx.raw_entry_id(relative), 'relative_path': relative, 'title': 'must-not-leak'}))
        try:
            (folder / 'alias.png').symlink_to(folder / '.CONFIG/private.png')
            index.entries.append(original.model_copy(update={'id': idx.raw_entry_id('alias.png'), 'relative_path': 'alias.png', 'title': 'must-not-leak'}))
        except OSError:  # Windows 无创建符号链接权限时仍测试大小写与 ../。
            pass
        idx.write_index(index)
    result = p['client'].get(f"/api/gateway-libraries/同事/{p['mount'].library_id}/assets")
    assert result.status_code == 200 and 'must-not-leak' not in result.text


def test_share_management_persists_and_requires_enabled_gateway(pair):
    p = pair
    with p['at_host']():
        lib = p['mount'].library_id
        assert p['client'].put(f'/api/team-library-gateway-share/{lib}', json={'enabled': True}).status_code == 409
        gateway_keys.update_settings(enabled=True)
        assert p['client'].put(f'/api/team-library-gateway-share/{lib}', json={'enabled': True}).status_code == 200
        assert lib in team_library.shared_library_ids()
        assert p['client'].get('/api/team-library-gateway-share').json()['shared_library_ids'] == [lib]
        gateway_keys.update_settings(enabled=False)
        assert p['client'].put(f'/api/team-library-gateway-share/{lib}', json={'enabled': False}).status_code == 200
        assert team_library.shared_library_ids() == set()


def test_proxy_rejects_extra_upstream_fields_and_marks_timeout_unreachable(pair, monkeypatch):
    from viewer_server import gateway_library_proxy
    p = pair
    class BadResponse:
        status_code = 200
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def json(self):
            return [{'id': p['mount'].library_id, 'name': '库', 'owner_name': '某人', 'updated_at': 'now', 'counts': {}, 'raw_path': '/private/secret'}]
    class FakeSession:
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def get(self, *_args, **kwargs):
            assert kwargs['timeout'] == 3 and kwargs['allow_redirects'] is False
            if state['timeout']:
                raise requests.Timeout('private URL and token must not escape')
            return BadResponse()
    state = {'timeout': False}
    monkeypatch.setattr(gateway_library_proxy.atelier_gateway, '_session', FakeSession)
    for timeout in (False, True):
        state['timeout'] = timeout
        response = p['client'].get('/api/gateway-libraries')
        assert response.status_code == 200
        assert response.json()[0]['unreachable'] and not response.json()[0]['libraries']
        assert 'private' not in response.text and p['secret'] not in response.text
