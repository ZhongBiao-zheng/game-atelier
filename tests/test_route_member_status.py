"""P2: persistent balance cooldown, recovery and local management boundaries."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json

import pytest

from character_workflow.lib import callers, gateway_keys, gateway_tasks, job_runner, model_routes
from tests.test_gateway import _dispatch, _seed_keys
from tests.test_route_failover import _job
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app
from viewer_server.connection_capabilities import local_capability


@pytest.fixture(autouse=True)
def state(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    monkeypatch.setattr(gateway_tasks, 'pump', lambda: None)
    yield
    model_routes._cooldowns.clear()


@pytest.mark.parametrize('message,reason', [
    ('image api 402', 'insufficient_balance'),
    ('image api 429: insufficient_quota', 'insufficient_balance'),
    ('HTTP 429: insufficient balance', 'insufficient_balance'),
    ('余额不足', 'insufficient_balance'), ('额度不足', 'insufficient_balance'),
    ('image api 429: rate limited', 'rate_limited'),
    ('quota exceeded', 'rate_limited'),
])
def test_classification(message, reason):
    assert model_routes.failover_reason(RuntimeError(message)) == reason


def test_persistent_restart_probe_and_renewal(monkeypatch):
    now = datetime(2026, 10, 24, tzinfo=timezone.utc)
    monkeypatch.setattr(model_routes, '_now', lambda: now)
    model_routes.cool_down('image', 'A', 'insufficient_balance')
    first = model_routes.member_statuses()[0]
    assert ('image', 'A') not in model_routes._cooldowns
    model_routes._cooldowns.clear()
    assert model_routes._cooling('image', 'A')
    assert not model_routes._cooling('video', 'A')
    now += timedelta(hours=1)
    assert not model_routes._cooling('image', 'A')
    model_routes.cool_down('image', 'A', 'insufficient_balance')
    renewed = model_routes.member_statuses()[0]
    assert renewed['since'] == first['since']
    assert datetime.fromisoformat(renewed['next_probe_at']) == now + timedelta(hours=1)
    assert model_routes._cooling('image', 'A')
    model_routes.mark_healthy('image', 'A')
    assert model_routes.member_statuses() == []


def test_nonbalance_is_memory_only(monkeypatch):
    now = 10.
    monkeypatch.setattr(model_routes.time, 'monotonic', lambda: now)
    model_routes.cool_down('image', 'A', 'rate_limited')
    assert not model_routes._status_file().exists()
    assert model_routes._cooling('image', 'A')
    now += 300
    assert not model_routes._cooling('image', 'A')


def test_success_without_record_does_not_write_status():
    model_routes.mark_healthy('image', 'A')
    assert not model_routes._status_file().exists()


@pytest.mark.parametrize('payload', ['broken', '{}', '{"members":null}', '{"members":[null]}',
                                    '{"members":[{"modality":"image"}]}'])
def test_corruption_is_logged_and_ignored(payload, caplog):
    path = model_routes._status_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload)
    assert not model_routes._cooling('image', 'A')
    assert '状态文件损坏' in caplog.text
    model_routes.cool_down('image', 'A', 'insufficient_balance')
    assert model_routes._cooling('image', 'A')


def test_concurrent_status_writes_preserve_members():
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda a: model_routes.cool_down('image', a, 'insufficient_balance'),
                      ['A', 'B', 'C', 'D', 'E', 'F']))
    assert len(model_routes.member_statuses()) == 6


def owner():
    _seed_keys()
    return gateway_keys.create_key('P2', allowed_aliases=['A', 'B'])[0]


def submit(key):
    return gateway_tasks.submit(key, idempotency_key='test', model='gpt-image-2',
                                prompt='x', n=1, size=None, params={}, files={})


def test_gateway_fallback_excludes_balance_and_keeps_permission():
    key = owner()
    model_routes.cool_down('image', 'A', 'insufficient_balance')
    model_routes.cool_down('image', 'B', 'rate_limited')
    assert gateway_tasks._pick_member('gpt-image-2', [], key)[0].alias == 'B'
    model_routes.cool_down('image', 'B', 'insufficient_balance')
    with pytest.raises(gateway_tasks.GatewayRequestError, match='供应商都欠费了') as exc:
        submit(key)
    assert exc.value.status == 503
    assert gateway_tasks._all_tasks() == []


def test_personal_auto_fallback_and_probe(monkeypatch):
    from tests.test_route_failover import _seed_keys as seed_personal
    seed_personal()
    now = datetime(2026, 10, 24, tzinfo=timezone.utc)
    monkeypatch.setattr(model_routes, '_now', lambda: now)
    model_routes.cool_down('image', 'A', 'insufficient_balance')
    model_routes.cool_down('image', 'B', 'rate_limited')
    assert model_routes.resolve_auto('image', 'gpt-image-2')[0].alias == 'B'
    model_routes.cool_down('image', 'B', 'insufficient_balance')
    with pytest.raises(model_routes.InsufficientBalanceError, match='供应商都欠费了'):
        model_routes.resolve_auto('image', 'gpt-image-2')
    now += timedelta(hours=1)
    assert model_routes.resolve_auto('image', 'gpt-image-2')[0].alias == 'A'


@pytest.mark.parametrize('gateway', [False, True])
def test_successful_execution_clears_status(monkeypatch, gateway):
    key = owner()
    now = datetime(2026, 10, 24, tzinfo=timezone.utc)
    monkeypatch.setattr(model_routes, '_now', lambda: now)
    model_routes.cool_down('image', 'A', 'insufficient_balance')
    now += timedelta(hours=1)
    if gateway:
        monkeypatch.setattr(callers, 'dispatch', _dispatch([]))
        assert gateway_tasks.run_task(submit(key)).status == 'done'
    else:
        monkeypatch.setattr(job_runner, 'dispatch', _dispatch([]))
        assert job_runner.run_job(_job(None).job_id).status.value == 'done'
    assert model_routes.member_statuses() == []


def test_management_restore_and_boundaries():
    owner()
    for alias in ['A', 'B']:
        model_routes.cool_down('image', alias, 'insufficient_balance')
    client = LocalTestClient(base_url='http://127.0.0.1', app=build_app())
    result = client.get('/api/model-routes/member-status').json()
    assert len(result['members']) == 2
    assert result['members'][0]['route_ids'] == ['gpt-image-2']
    assert result['unavailable_routes'][0]['id'] == 'gpt-image-2'
    assert 'test-only' not in json.dumps(result)
    result = client.post('/api/model-routes/member-status/restore', json={
        'modality': 'image', 'alias': 'A',
    }).json()
    assert [r['alias'] for r in result['members']] == ['B']
    assert result['unavailable_routes'] == []
    assert client.post('/api/model-routes/member-status/restore', json={
        'modality': 'invalid', 'alias': 'A',
    }).status_code == 422
    assert local_capability('GET', '/api/model-routes/member-status') == 'manage'
    assert local_capability('POST', '/api/model-routes/member-status/restore') == 'manage'


def test_queued_gateway_task_releases_reservation_when_members_become_insolvent():
    key = owner()
    task = submit(key)
    for alias in ['A', 'B']:
        model_routes.cool_down('image', alias, 'insufficient_balance')
    done = gateway_tasks.run_task(task)
    assert done.status == 'failed' and done.error_kind == 'unavailable'
    assert '供应商都欠费了' in done.error
    assert done.charged_cny == 0


def test_studio_all_balance_error_is_user_visible():
    from tests.test_route_failover import _seed_keys as seed_personal
    seed_personal()
    for alias in ['A', 'B']:
        model_routes.cool_down('image', alias, 'insufficient_balance')
    client = LocalTestClient(base_url='http://127.0.0.1', app=build_app())
    response = client.post('/api/studio/jobs', json={
        'kind': 'image', 'model': 'gpt-image-2', 'prompt': 'x', 'params': {},
    })
    assert response.status_code == 422
    assert '供应商都欠费了' in response.json()['detail']


def _gateway_balance_error(prefix: str) -> RuntimeError:
    inner = job_runner._friendly_error(RuntimeError('image api 402: insufficient balance'))
    return RuntimeError(f'{prefix}网关的供应商都不可用：{inner}')


@pytest.mark.parametrize('prefix', [
    'gateway api 503: gateway_unavailable — ',  # 任务协议（图片 / 视频 / 音频）
    'text api 503: {"error": {"type": "gateway_unavailable", "message": "',  # 文本透传
])
def test_gateway_relayed_balance_error_is_unavailable_not_balance(prefix):
    assert model_routes.failover_reason(_gateway_balance_error(prefix)) == 'unavailable'


def test_gateway_alias_is_never_persisted_as_insolvent():
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(alias='Hub', provider='atelier', access_key='atg_test',
                              base_url='http://192.168.0.2:5180', modalities=['image'],
                              models=[], created_at='test'))
    model_routes.cool_down('image', 'Hub', 'insufficient_balance')
    assert model_routes.member_statuses() == []
    assert model_routes._cooling('image', 'Hub')


def test_temporary_failure_is_not_reported_as_balance_failure():
    owner()
    model_routes.cool_down('image', 'A', 'unavailable')
    client = LocalTestClient(base_url='http://127.0.0.1', app=build_app())
    result = client.get('/api/model-routes/member-status').json()
    assert result['members'][0]['reason'] == 'unavailable'
    assert result['members'][0]['since'] is None
    assert result['unavailable_routes'] == []
    paths = {route.path for route in client.app.routes}
    assert '/api/gateway/members' not in paths
    assert '/api/gateway/members/restore' not in paths
    assert '/api/gateway/usage' not in paths
