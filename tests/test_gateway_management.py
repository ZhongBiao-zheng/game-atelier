"""P5 management contracts, events, quota cache and Retry-After."""
from datetime import timedelta
from unittest.mock import Mock

import pytest
import requests

from character_workflow.lib import gateway_tasks, gateway_live, gateway_keys, keys, model_routes
from character_workflow.lib.callers import atelier_gateway
from character_workflow.lib.job_runner import _friendly_error
from viewer_server import gateway_routes
from viewer_server.connection_capabilities import local_capability
from viewer_server.server_app import build_app
from tests.local_client import LocalTestClient


@pytest.fixture
def setup(isolated_data_root, monkeypatch):
    monkeypatch.setattr(gateway_tasks, 'pump', lambda: None)
    gateway_live.listeners.clear()
    gateway_live._calls.clear()
    gateway_routes._me_cache.clear()
    model_routes._cooldowns.clear()
    keys.add_key(keys.KeySpec(alias='local', provider='openai', access_key='fake', created_at='test',
        models=[keys.ModelSpec(id='gpt-image-2', name='GPT', modality='image')]))
    owner, _ = gateway_keys.create_key('User')
    yield LocalTestClient(base_url='http://127.0.0.1', app=build_app()), owner
    gateway_live.listeners.clear()
    gateway_live._calls.clear()
    gateway_routes._me_cache.clear()
    model_routes._cooldowns.clear()


def task(owner, identifier='one', **changes):
    result = gateway_tasks.submit(owner, idempotency_key=identifier, model='gpt-image-2',
                                 prompt='private prompt', n=1, size=None, params={}, files={})
    return gateway_tasks._update(result.task_id, **changes) if changes else result


def test_task_snapshots_recent_limit_and_preview(setup):
    client, owner = setup
    events = []
    gateway_live.listeners.append(events.append)
    current = task(owner)
    assert events[-1]['prompt'] == 'private prompt'
    assert 'key_id' not in events[-1] and 'params' not in events[-1]
    assert client.get('/api/gateway/tasks').json()['tasks'][0]['task_id'] == current.task_id
    assert local_capability('GET', '/api/gateway/tasks') == 'manage'
    assert local_capability('GET', f'/api/gateway/tasks/{current.task_id}/outputs/0') == 'manage'
    out = gateway_tasks._files_dir(current.task_id) / 'out'
    out.mkdir(parents=True)
    (out / '0.png').write_bytes(b'preview')
    gateway_tasks._finish(current, status='done', outputs=['0.png'], output_types=['image/png'])
    assert client.get('/api/gateway/tasks').json()['tasks'] == []
    assert client.get('/api/gateway/tasks?scope=recent').json()['tasks'][0]['outputs'] == 1
    assert client.get(f'/api/gateway/tasks/{current.task_id}/outputs/0').content == b'preview'
    assert client.get(f'/api/gateway/tasks/{current.task_id}/outputs/1').status_code == 404
    assert client.get('/api/gateway/tasks?scope=bad').status_code == 422
    old = (gateway_tasks._now() - timedelta(hours=25)).isoformat()
    gateway_tasks._save(current.model_copy(update={'task_id': 'f' * 32, 'status': 'done'}))
    # _save owns updated_at
    # Write an old record to simulate elapsed time.
    gateway_tasks.atomic_write_json(gateway_tasks._task_file('f' * 32), current.model_copy(update={
        'task_id': 'f' * 32, 'status': 'done', 'updated_at': old}).model_dump(mode='json'))
    assert len(client.get('/api/gateway/tasks?scope=recent').json()['tasks']) == 1
    for index in range(205):
        gateway_tasks._save(current.model_copy(update={
            'task_id': f'{index:032x}', 'status': 'done'}))
    recent = client.get('/api/gateway/tasks?scope=recent').json()['tasks']
    assert len(recent) == 200
    assert [row['updated_at'] for row in recent] == sorted(
        [row['updated_at'] for row in recent], reverse=True)


def test_text_events_hide_prompt_and_end_removes_active(setup):
    client, _ = setup
    seen = []
    gateway_live.listeners.append(seen.append)
    gateway_live.register(dict(call_id='text', key_name='User', route_id='gpt', member_alias='local',
                               started_at=gateway_tasks._now().isoformat(), stream=True))
    row = client.get('/api/gateway/tasks').json()['tasks'][0]
    assert row['kind'] == 'text' and row['prompt'] is None
    assert seen[-1]['task_id'] == 'text'
    gateway_live.finish('text', 'done')
    assert not client.get('/api/gateway/tasks').json()['tasks']
    assert seen[-1]['status'] == 'done'


def test_provider_me_cache_includes_credentials_and_hides_failure(setup, monkeypatch):
    client, _ = setup
    clock = [100.0]
    monkeypatch.setattr(gateway_routes.time, 'monotonic', lambda: clock[0])
    keys.add_key(keys.KeySpec(alias='hub', provider='atelier', access_key='fake', created_at='test', base_url='http://127.0.0.1:1'))
    response = Mock()
    response.json.return_value = {'name': 'User', 'limits': []}
    session = Mock()
    session.__enter__ = Mock(return_value=session)
    session.__exit__ = Mock(return_value=False)
    session.get.return_value = response
    monkeypatch.setattr(atelier_gateway, '_session', lambda: session)
    assert client.get('/api/gateway/providers/hub/me').json()['name'] == 'User'
    client.get('/api/gateway/providers/hub/me')
    assert session.get.call_count == 1
    clock[0] += 31
    client.get('/api/gateway/providers/hub/me')
    assert session.get.call_count == 2
    keys.patch_key('hub', {'access_key': 'new-fake'})
    session.get.side_effect = requests.ConnectionError('private address')
    assert client.get('/api/gateway/providers/hub/me').json() is None
    assert session.get.call_count == 3
    client.get('/api/gateway/providers/hub/me')
    assert session.get.call_count == 3


def test_quota_error_preserves_detail_and_cools_before_next_job(setup, monkeypatch):
    keys.add_key(keys.KeySpec(alias='hub', provider='atelier', access_key='fake', created_at='test',
        base_url='http://127.0.0.1:1', models=[keys.ModelSpec(id='gpt-image-2', name='GPT', modality='image')]))
    model_routes.put_alias_first('hub')
    response = Mock(status_code=429, headers={'Retry-After': '120'}, reason='limited')
    response.json.return_value = {'detail': '中转额度已用完，明日重置'}
    session = Mock()
    session.post.return_value = response
    now = [100.0]
    monkeypatch.setattr(model_routes.time, 'monotonic', lambda: now[0])
    with pytest.raises(atelier_gateway.GatewayError) as caught:
        atelier_gateway._submit(session, 'http://gateway', {}, alias='hub', kind='image',
            model='gpt-image-2', prompt='test', n=1, params={}, uploads={})
    assert _friendly_error(caught.value) == '中转额度已用完，明日重置'
    assert model_routes.resolve_auto('image', 'gpt-image-2')[0].alias == 'local'
    now[0] = 221
    assert model_routes.resolve_auto('image', 'gpt-image-2')[0].alias == 'hub'


def test_gateway_events_are_only_sent_to_management_sessions(setup):
    import asyncio
    import threading
    import time
    from types import SimpleNamespace
    from viewer_server.sse import events, hub

    async def check(kind):
        from viewer_server.connection_auth import ConnectionPrincipal
        session = SimpleNamespace(event_connections=0, revoked=threading.Event(),
            expires_at=time.time() + 60, principal=ConnectionPrincipal(kind, 'test-session'))
        store = SimpleNamespace(lock=threading.Lock(), _refresh=lambda: None)
        request = SimpleNamespace(state=SimpleNamespace(connection_session=session),
                                  app=SimpleNamespace(state=SimpleNamespace(connection_store=store)))
        response = await events(request)
        stream = response.body_iterator
        await anext(stream)
        hub.broadcast('gateway_task', {'prompt': 'private'})
        hub.broadcast('job-changed', {'job_id': 'local'})
        event = await anext(stream)
        assert ('gateway_task' in event) == (kind == 'local')
        await stream.aclose()
    asyncio.run(check('agent'))
    asyncio.run(check('local'))


def test_text_gateway_quota_error_uses_retry_after(setup, monkeypatch):
    from character_workflow.lib.callers import openai_text
    response = Mock(status_code=429, headers={'Retry-After': '180'}, reason='limited')
    response.json.return_value = {'error': {'message': '中转额度已用完'}}
    monkeypatch.setattr(openai_text.requests, 'post', lambda *a, **kw: response)
    with pytest.raises(atelier_gateway.GatewayError) as caught:
        openai_text._post_json(url='http://gateway/gateway/v1/openai/chat/completions',
                              access_key='fake', payload={}, timeout=1, gateway_alias='hub')
    assert _friendly_error(caught.value) == '中转额度已用完'
    assert model_routes._cooling('text', 'hub')
