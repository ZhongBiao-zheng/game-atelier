"""P3 relay contracts with a fake upstream; no paid requests."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import (
    canvas_agent_models, gateway_keys, gateway_live, gateway_quota, gateway_tasks,
    generation_pricing, keys, model_routes,
)
from character_workflow.lib.callers import atelier_gateway, openai_text
from character_workflow.lib.callers.openai_compat import key_api_root
from viewer_server import gateway_openai
from viewer_server.gateway_app import create_gateway_app

BASE = '/gateway/v1/openai'


@pytest.fixture(autouse=True)
def clean(isolated_data_root):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    gateway_live._calls.clear()
    gateway_live.listeners.clear()
    yield
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    gateway_live._calls.clear()
    gateway_live.listeners.clear()


@pytest.fixture
def setup(monkeypatch):
    for alias, model in [('A', 'vendor/gpt-test'), ('B', 'gpt-test')]:
        keys.add_key(keys.KeySpec(alias=alias, provider='custom', access_key=f'secret-{alias}',
            base_url=f'https://{alias.lower()}.example', created_at='test',
            models=[keys.ModelSpec(id=model, name=model, modality='text', protocol='openai-chat')]))
    owner, token = gateway_keys.create_key('文本测试')
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={'model': 'vendor/gpt-test', 'choices': [],
                                        'usage': {'prompt_tokens': 10, 'completion_tokens': 20}})

    def upstream(handle=handler):
        monkeypatch.setattr(gateway_openai, '_client', lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handle)))
    upstream()
    app = create_gateway_app()
    client = TestClient(app, headers={'Authorization': f'Bearer {token}'})
    return owner, token, seen, upstream, app, client


def rows():
    return gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime('%Y-%m'))


@pytest.mark.parametrize('endpoint', ['chat/completions', 'responses'])
def test_json_rewrites_model_and_does_not_forward_headers(setup, endpoint):
    owner, _, seen, _, _, client = setup
    response = client.post(f'{BASE}/{endpoint}', json={'model': 'gpt-test', 'messages': []},
                           headers={'X-Upstream-Secret': 'do-not-forward', 'Cookie': 'private'})
    assert response.status_code == 200
    assert response.json()['model'] == 'gpt-test'
    assert json.loads(seen[0].content)['model'] == 'vendor/gpt-test'
    assert seen[0].headers['Authorization'] == 'Bearer secret-A'
    assert 'X-Upstream-Secret' not in seen[0].headers and 'Cookie' not in seen[0].headers
    assert str(seen[0].url) == f'https://a.example/v1/{endpoint}'
    assert rows()[0]['kind'] == 'text' and rows()[0]['input_tokens'] == 10
    assert rows()[0]['output_tokens'] == 20 and rows()[0]['charged_cny'] == 0
    assert 'prompt' not in rows()[0]
    assert gateway_quota._inflight == {} and gateway_live.active() == []


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks, error=None):
        self.chunks, self.error = chunks, error
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        if self.error:
            raise self.error

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize('endpoint', ['chat/completions', 'responses'])
def test_stream_bytes_unchanged_and_usage_across_chunks(setup, endpoint):
    _, _, seen, upstream, _, client = setup
    usage = {'usage': {'prompt_tokens': 7, 'completion_tokens': 11}}
    if endpoint == 'responses':
        usage = {'response': {'usage': {'input_tokens': 7, 'output_tokens': 11}}}
    wire = (b'data: {"model":"vendor/gpt-test","choices":[]}\n\n'
            + b'data: ' + json.dumps(usage).encode() + b'\r\n\r\ndata: [DONE]\n\n')
    source = Chunks([wire[:27], wire[27:80], wire[80:]])

    def handle(request):
        seen.append(request)
        assert gateway_live.active()[0]['stream'] is True
        assert gateway_quota._inflight
        return httpx.Response(200, stream=source)
    upstream(handle)
    response = client.post(f'{BASE}/{endpoint}', json={'model': 'gpt-test', 'stream': True})
    assert response.content == wire and source.closed
    if endpoint == 'chat/completions':
        assert json.loads(seen[0].content)['stream_options'] == {'include_usage': True}
    assert rows()[0]['input_tokens'] == 7 and rows()[0]['output_tokens'] == 11
    assert gateway_live.active() == [] and gateway_quota._inflight == {}


@pytest.mark.parametrize('failure', [401, 402, 403, 404, 429, 'connect'])
def test_pre_stream_failure_switches_member(setup, failure):
    _, _, seen, upstream, _, client = setup
    def handle(request):
        seen.append(request)
        if request.url.host == 'a.example':
            if failure == 'connect':
                raise httpx.ConnectError('connection refused')
            return httpx.Response(failure, json={'error': 'unavailable'})
        return httpx.Response(200, stream=Chunks([b'data: [DONE]\n\n']))
    upstream(handle)
    assert client.post(f'{BASE}/chat/completions', json={
        'model': 'gpt-test', 'stream': True,
    }).status_code == 200
    assert len(seen) == 2
    assert rows()[0]['member_trail'] == ['A', 'B']
    assert rows()[0]['status'] == 'done'


def test_mid_stream_failure_never_switches_and_charges_nothing(setup, monkeypatch):
    _, _, seen, upstream, _, client = setup
    monkeypatch.setitem(generation_pricing._PRICES['text_yuan_per_million_tokens'],
                        'vendor/gpt-test', {'input': 1, 'output': 2})
    wire = b'data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n'
    source = Chunks([wire], httpx.ReadError('lost connection'))
    def handle(request):
        seen.append(request)
        return httpx.Response(200, stream=source)
    upstream(handle)
    assert client.post(f'{BASE}/chat/completions', json={
        'model': 'gpt-test', 'stream': True,
    }).content == wire
    assert len(seen) == 1 and source.closed
    # 第三批规则①：价格表算出的金额不算确认收费，失败扣 0；用量与金额照记，供对账。
    row = rows()[0]
    assert row['status'] == 'failed' and row['charged_cny'] == 0
    assert (row['input_tokens'], row['output_tokens']) == (10, 20)
    assert row['actual_cost_cny'] == .00005 and row['actual_cost_source'] == 'price_table'
    assert row['usage_missing'] is None
    assert not gateway_quota._inflight


def test_quota_admission_settlement_and_error_shape(setup, monkeypatch):
    owner, _, seen, upstream, _, client = setup
    gateway_keys.update_key(owner.id, limits=[{'period': 'day', 'cap_cny': .0021}])
    monkeypatch.setitem(generation_pricing._PRICES['text_yuan_per_million_tokens'],
                        'vendor/gpt-test', {'input': 1, 'output': 2})
    def handle(request):
        seen.append(request)
        active = gateway_quota.usage_summary(gateway_keys.read_config().keys[0])[0]
        assert active['reserved_cny'] > .002
        assert active['used_cny'] == 0
        return httpx.Response(200, json={'model': 'vendor/gpt-test',
            'usage': {'input_tokens': 1000, 'output_tokens': 1000}})
    upstream(handle)
    assert client.post(f'{BASE}/responses', json={'model': 'gpt-test'}).status_code == 200
    assert rows()[0]['charged_cny'] == .003
    denied = client.post(f'{BASE}/responses', json={'model': 'gpt-test'})
    assert denied.status_code == 429 and int(denied.headers['Retry-After']) > 0
    assert denied.json()['error']['code'] == 429 and len(seen) == 1
    assert not gateway_quota._inflight


@pytest.mark.parametrize('status,payload', [(404, {'model': 'unknown'}), (422, {'stream': True}),
                                          (422, {'model': 'gpt-test', 'stream': 'yes'})])
def test_invalid_requests_openai_errors(setup, status, payload):
    response = setup[-1].post(f'{BASE}/responses', json=payload)
    assert response.status_code == status and 'error' in response.json()


def test_permission_auth_and_body_limit(setup, monkeypatch):
    owner, _, seen, _, app, client = setup
    assert TestClient(app).get(f'{BASE}/models').json()['error']['code'] == 401
    gateway_keys.update_key(owner.id, scope=[])
    assert client.post(f'{BASE}/responses', json={'model': 'gpt-test'}).status_code == 403
    gateway_keys.update_key(owner.id, scope=[{'alias': 'A', 'models': ['other']}])
    assert client.post(f'{BASE}/responses', json={'model': 'gpt-test'}).status_code == 403
    monkeypatch.setattr(gateway_openai, 'MAX_BODY_BYTES', 10)
    assert client.post(f'{BASE}/responses', content=b'12345678901').status_code == 413
    assert not seen and not rows()


def test_models_preserve_capabilities_and_filter_permissions(setup):
    owner, _, _, upstream, _, client = setup
    def handle(request):
        return httpx.Response(200, json={'data': [{'id': 'vendor/gpt-test',
            'architecture': {'output_modalities': ['text']},
            'supported_parameters': ['tools', 'reasoning'], 'access_key': 'not-public'}]})
    upstream(handle)
    result = client.get(f'{BASE}/models').json()['data']
    assert result[0]['id'] == 'gpt-test' and canvas_agent_models.is_chat_model(result[0])
    assert result[0]['supported_parameters'] == ['tools', 'reasoning']
    assert 'access_key' not in result[0]
    gateway_keys.update_key(owner.id, scope=[{'alias': 'B'}])
    result = client.get(f'{BASE}/models').json()['data']
    assert result[0]['supported_parameters'] == ['tools']
    assert canvas_agent_models.is_chat_model(result[0])
    gateway_keys.update_key(owner.id, scope=[])
    assert client.get(f'{BASE}/models').json()['data'] == []


def test_all_upstreams_unavailable_error_hides_secrets_and_paths(setup):
    _, _, _, upstream, _, client = setup
    upstream(lambda request: httpx.Response(401, text='secret-A /private/user/key.json'))
    response = client.post(f'{BASE}/responses', json={'model': 'gpt-test'})
    assert response.status_code == 503
    assert response.json()['error']['type'] == 'gateway_unavailable'
    assert 'secret-A' not in response.text and '/private/' not in response.text
    assert not gateway_quota._inflight and rows()[0]['status'] == 'failed'


def test_gateway_models_and_text_client_use_relay_root(setup, monkeypatch):
    key = keys.KeySpec(alias='Hub', provider='atelier', access_key='local-only',
                       base_url='http://127.0.0.1:5180/', created_at='test')
    key.models = atelier_gateway.gateway_models([{'id': 'gpt-test', 'name': 'test',
        'modality': 'text', 'members': [{'alias': 'A', 'provider': 'custom',
        'model_id': 'vendor/gpt-test', 'name': 'test', 'protocol': 'openai-responses'}]}])
    keys.add_key(key)
    assert canvas_agent_models.enabled_text_models(key) == key.models
    assert key_api_root(key) == 'http://127.0.0.1:5180/gateway/v1/openai'
    assert canvas_agent_models.chat_base_url(key) == key_api_root(key)
    assert 'atelier' in canvas_agent_models.CHAT_PROVIDERS
    def post(**kwargs):
        assert kwargs['url'] == key_api_root(key) + '/responses'
        return {'output_text': 'ok'}
    monkeypatch.setattr(openai_text, '_post_json', post)
    assert openai_text.generate(prompt='hello', model='gpt-test', alias='Hub') == ['ok']


def test_httpx_uses_proxy_bypass(monkeypatch):
    from character_workflow.lib import net_env
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:9')
    monkeypatch.setenv('NO_PROXY', '')
    monkeypatch.setenv('no_proxy', '')
    net_env.configure_proxy_bypass()
    async def check():
        async with gateway_openai._client() as client:
            direct = client._transport_for_url(httpx.URL('https://api.openai-hk.com/v1'))
            proxy = client._transport_for_url(httpx.URL('https://api.openai.com/v1'))
            assert direct is client._transport and proxy is not client._transport
    asyncio.run(check())


async def test_agents_sdk_tool_call_stream_through_gateway(setup):
    from agents import Agent, OpenAIChatCompletionsModel, Runner, function_tool, set_tracing_disabled
    from openai import AsyncOpenAI

    _, token, seen, upstream, app, _ = setup
    set_tracing_disabled(True)
    invoked = []

    @function_tool
    def add_one(value: int) -> int:
        """Add one to a number."""
        invoked.append(value)
        return value + 1

    def handle(request):
        seen.append(request)
        body = json.loads(request.content)
        assert body['model'] == 'vendor/gpt-test'
        assert body['stream_options']['include_usage'] is True
        if any(m['role'] == 'tool' for m in body['messages']):
            delta = {'role': 'assistant', 'content': '3'}
            finish = 'stop'
        else:
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'tool-1',
                'type': 'function', 'function': {'name': 'add_one', 'arguments': '{"value":2}'}}]}
            finish = 'tool_calls'
        chunks = []
        for d, f in [(delta, None), ({}, finish)]:
            payload = {'id': 'chat-1', 'object': 'chat.completion.chunk', 'created': 1,
                       'model': 'vendor/gpt-test',
                       'choices': [{'index': 0, 'delta': d, 'finish_reason': f}]}
            chunks.append(b'data: ' + json.dumps(payload).encode() + b'\n\n')
        chunks.extend([b'data: {"id":"chat-1","object":"chat.completion.chunk",'
                       b'"created":1,"model":"vendor/gpt-test","choices":[],"usage":'
                       b'{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
                       b'data: [DONE]\n\n'])
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=Chunks(chunks))
    upstream(handle)
    key = keys.KeySpec(alias='Hub', provider='atelier', base_url='http://test',
                       access_key=token, created_at='test', models=[])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as transport:
        async with AsyncOpenAI(base_url=key_api_root(key), api_key=token,
                               http_client=transport, max_retries=0) as client:
            agent = Agent(name='relay-test', tools=[add_one],
                          model=OpenAIChatCompletionsModel(model='gpt-test', openai_client=client))
            result = Runner.run_streamed(agent, 'Add one to two')
            events = [event async for event in result.stream_events()]
    assert result.final_output == '3' and invoked == [2] and events
    assert len(seen) == 2 and len(rows()) == 2
    assert not gateway_quota._inflight and not gateway_live.active()


@pytest.mark.parametrize('status', [500, 503, 504, 'read-timeout'])
def test_ambiguous_pre_stream_failure_does_not_retry(setup, status):
    _, _, seen, upstream, _, client = setup
    def handle(request):
        seen.append(request)
        if status == 'read-timeout':
            raise httpx.ReadTimeout('upstream may be running')
        return httpx.Response(status, text='internal error')
    upstream(handle)
    response = client.post(f'{BASE}/responses', json={'model': 'gpt-test', 'stream': True})
    assert response.status_code == 503 and len(seen) == 1
    assert response.json()['error']['type'] == 'gateway_upstream_error'
    assert model_routes.failover_reason(openai_text.OpenAITextError(
        f'text api 503: {response.text}',
    )) is None
    assert rows()[0]['status'] == 'failed' and not gateway_quota._inflight


async def test_client_disconnect_releases_reservation(setup):
    from starlette.requests import Request
    owner, _, _, upstream, _, _ = setup
    source = Chunks([b'data: {"usage":{"input_tokens":3,"output_tokens":5}}\n\n',
                     b'data: [DONE]\n\n'])
    upstream(lambda request: httpx.Response(200, stream=source))
    async def receive():
        return {'type': 'http.request', 'body': b'{"model":"gpt-test","stream":true}'}
    request = Request({'type': 'http', 'method': 'POST', 'headers': []}, receive)
    response = await gateway_openai._relay(request, owner, 'responses')
    assert gateway_live.active() and gateway_quota._inflight
    await anext(response.body_iterator)
    await response.body_iterator.aclose()
    assert rows()[0]['status'] == 'failed' and rows()[0]['input_tokens'] == 3
    assert not gateway_live.active() and not gateway_quota._inflight and source.closed


async def test_disconnect_before_body_starts_also_releases(setup):
    from starlette.requests import Request
    owner, _, _, upstream, _, _ = setup
    source = Chunks([b'data: [DONE]\n\n'])
    upstream(lambda request: httpx.Response(200, stream=source))
    async def receive():
        return {'type': 'http.request', 'body': b'{"model":"gpt-test","stream":true}'}
    response = await gateway_openai._relay(
        Request({'type': 'http', 'method': 'POST', 'headers': []}, receive), owner, 'responses',
    )
    async def broken_send(message):
        raise OSError('client closed')
    with pytest.raises(Exception):
        await response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, broken_send)
    assert source.closed and not gateway_quota._inflight and not gateway_live.active()
    assert rows()[0]['status'] == 'failed'


def test_recent_output_estimate_uses_latest_fifty_calls(setup):
    from character_workflow.lib.gateway_text import average_output_tokens
    owner = setup[0]
    path = gateway_tasks.usage_file(gateway_tasks._now().strftime('%Y-%m'))
    path.parent.mkdir(parents=True, exist_ok=True)
    entries = [{'key_id': owner.id, 'kind': 'text', 'output_tokens': 10000}]
    entries += [{'key_id': owner.id, 'kind': 'text', 'output_tokens': 50}] * 50
    entries += [{'key_id': 'other', 'kind': 'text', 'output_tokens': 9999}]
    path.write_text('\n'.join(json.dumps(row) for row in entries))
    assert average_output_tokens(owner.id) == 50


def test_alias_permission_and_cooldown_fallback_never_use_denied_member(setup):
    owner, _, seen, _, _, client = setup
    gateway_keys.update_key(owner.id, scope=[{'alias': 'B'}])
    model_routes.cool_down('text', 'B', 'rate_limited')
    assert client.post(f'{BASE}/responses', json={'model': 'gpt-test'}).status_code == 200
    assert seen[0].url.host == 'b.example'
    model_routes.cool_down('text', 'B', 'insufficient_balance')
    assert client.post(f'{BASE}/responses', json={'model': 'gpt-test'}).status_code == 503
    assert len(seen) == 1


def test_text_job_gateway_unavailable_switches_to_local_key(setup, monkeypatch):
    from character_workflow.lib import job_runner
    from character_workflow.lib.jobs import save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
    key = keys.KeySpec(alias='Hub', provider='atelier', base_url='http://127.0.0.1:5180',
                       access_key='fake', created_at='test', models=[
                           keys.ModelSpec(id='gpt-test', name='test', modality='text')])
    keys.add_key(key)
    calls = []
    def post(**kwargs):
        calls.append(kwargs['url'])
        if '/gateway/v1/openai/' in kwargs['url']:
            raise openai_text.OpenAITextError('text api 503: {"error":{"type":"gateway_unavailable"}}')
        return {'choices': [{'message': {'content': 'local result'}}]}
    monkeypatch.setattr(openai_text, '_post_json', post)
    job = save_job(Job(job_id='job-text-relay', character_id='x', prompt='x',
        submitted_at='2026-10-24T00:00:00+00:00', model='gpt-test',
        params=JobParams(route_id='gpt-test'), output_paths=[], status=JobStatus.PENDING,
        error=None, kind=JobKind.TEXT, namespace='studio',
        alias='Hub', provider='atelier'))
    done = job_runner.run_job(job.job_id)
    assert done.status == JobStatus.DONE and done.alias == 'A'
    assert done.params.route_tried == ['Hub'] and len(calls) == 2


def test_text_admission_is_atomic_with_reservation(setup, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from character_workflow.lib.gateway_text import TextCall
    owner = gateway_keys.update_key(setup[0].id, limits=[{'period': 'day', 'cap_cny': .0021}])
    monkeypatch.setitem(generation_pricing._PRICES['text_yuan_per_million_tokens'],
                        'vendor/gpt-test', {'input': 1, 'output': 2})
    barrier = Barrier(2)
    picked = gateway_openai._pick(owner, 'gpt-test', [])
    def create(_):
        barrier.wait()
        try:
            return TextCall(owner, 'gpt-test', picked, 60, True)
        except gateway_tasks.GatewayRequestError as error:
            return error.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, range(2)))
    assert sum(r == 429 for r in results) == 1
    for result in results:
        if isinstance(result, TextCall):
            result.finish('failed')
    assert not gateway_quota._inflight


def test_local_media_paths_rejected_without_exposing_path(setup):
    client = setup[-1]
    response = client.post(f'{BASE}/responses', json={'model': 'gpt-test', 'input': [
        {'role': 'user', 'content': [{'type': 'input_image', 'image_url': '/private/local.png'}]},
    ]})
    assert response.status_code == 422 and '/private/local.png' not in response.text
    assert not setup[2]


def _priced_setup(setup, monkeypatch, usage):
    _, _, seen, upstream, _, client = setup
    monkeypatch.setitem(generation_pricing._PRICES['text_yuan_per_million_tokens'],
                        'vendor/gpt-test', {'input': 1, 'output': 2})

    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={'model': 'vendor/gpt-test', 'choices': [], 'usage': usage})
    upstream(handle)
    return client


def _post_raw(client, payload):
    body = json.dumps(payload).encode('utf-8')
    response = client.post(f'{BASE}/chat/completions', content=body,
                           headers={'Content-Type': 'application/json'})
    assert response.status_code == 200, response.text
    return len(body)


def test_inline_images_are_reserved_per_image_not_per_byte(setup, monkeypatch):
    from character_workflow.lib.gateway_text import IMAGE_INPUT_TOKENS_ESTIMATE, input_tokens_estimate

    client = _priced_setup(setup, monkeypatch, {'prompt_tokens': 4300, 'completion_tokens': 20})
    image = 'data:image/jpeg;base64,' + 'A' * 150_000  # 约 110 KB 的 JPEG
    payload = {'model': 'gpt-test', 'messages': [{'role': 'user', 'content': [
        {'type': 'text', 'text': '看这三张图'},
        *({'type': 'image_url', 'image_url': {'url': image}} for _ in range(3))]}]}
    body_size = _post_raw(client, payload)
    row = rows()[0]
    text_bytes = body_size - 3 * len(image)
    before = generation_pricing.estimate_text_cost_cny('vendor/gpt-test', body_size // 3, 1000)
    after = generation_pricing.estimate_text_cost_cny(
        'vendor/gpt-test', text_bytes // 3 + 3 * IMAGE_INPUT_TOKENS_ESTIMATE, 1000)
    actual = generation_pricing.estimate_text_cost_cny('vendor/gpt-test', 4300, 20)
    assert input_tokens_estimate(payload, body_size) == text_bytes // 3 + 3 * 3800
    # 改前按字节估：约 15 万 token；改后按张数：约 11400；上游实际 4300。
    assert (before, row['estimated_cny'], row['charged_cny']) == (0.152114, after, actual)
    assert after == 0.013491 and actual == 0.00434
    assert after >= actual and before > 30 * actual


def test_text_only_reservation_is_unchanged(setup, monkeypatch):
    client = _priced_setup(setup, monkeypatch, {'prompt_tokens': 10, 'completion_tokens': 20})
    payload = {'model': 'gpt-test', 'messages': [{'role': 'user', 'content': '只有文字' * 50}]}
    body_size = _post_raw(client, payload)
    assert rows()[0]['estimated_cny'] == generation_pricing.estimate_text_cost_cny(
        'vendor/gpt-test', body_size // 3, 1000)


def test_image_estimate_only_counts_image_data_urls():
    from character_workflow.lib.gateway_text import input_tokens_estimate

    audio = 'data:audio/wav;base64,' + 'B' * 3000
    prompt = 'data:image/png;base64,' + 'C' * 3000  # 写在提示词里，不是图片字段
    payload = {'messages': [{'role': 'user', 'content': [
        {'type': 'text', 'text': prompt}, {'type': 'input_audio', 'url': audio},
        {'type': 'input_image', 'image_url': 'https://example.com/a.png'}]}]}
    assert input_tokens_estimate(payload, 9000) == 3000


def test_call_tag_lands_only_on_the_callers_usage_row_and_bad_tags_are_ignored(setup, monkeypatch):
    client = _priced_setup(setup, monkeypatch, {'prompt_tokens': 1000, 'completion_tokens': 1000})
    seen = setup[2]
    payload = {'model': 'gpt-test', 'messages': []}
    tagged = client.post(f'{BASE}/chat/completions', json=payload,
                         headers={'X-Atelier-Call-Tag': 'session-abc12345:7'})
    assert tagged.status_code == 200
    assert 'x-atelier-call-tag' not in {name.lower() for name in seen[-1].headers}  # 不转给上游
    for bad in ('has space', 'x' * 129, '中文', 'a/b'):
        response = client.post(f'{BASE}/chat/completions', json=payload,
                               headers={'X-Atelier-Call-Tag': bad.encode('utf-8')})
        assert response.status_code == 200  # 不合规的标记当没带，照常中转
    usage = rows()
    assert usage[0]['call_tag'] == 'session-abc12345:7'
    assert all('call_tag' not in row for row in usage[1:])


def test_me_reports_a_call_tag_only_for_the_asking_key(setup, monkeypatch):
    client = _priced_setup(setup, monkeypatch, {'prompt_tokens': 1000, 'completion_tokens': 1000})
    for _ in range(2):
        client.post(f'{BASE}/chat/completions', json={'model': 'gpt-test', 'messages': []},
                    headers={'X-Atelier-Call-Tag': 'session-abc12345:7'})
    charged = sum(row['charged_cny'] for row in rows())
    me = client.get('/gateway/v1/me', params={'call_tag': 'session-abc12345:7'}).json()
    assert me['call_tag'] == {'requests': 2, 'charged_cny': round(charged, 6)} and charged == 0.006
    assert client.get('/gateway/v1/me').json().get('call_tag') is None
    assert 'call_tag' not in client.get('/gateway/v1/me', params={'call_tag': 'bad tag'}).json()
    _, other_token = gateway_keys.create_key('另一个成员')
    other = TestClient(setup[4], headers={'Authorization': f'Bearer {other_token}'})
    assert other.get('/gateway/v1/me', params={'call_tag': 'session-abc12345:7'}).json()['call_tag'] \
        == {'requests': 0, 'charged_cny': 0}
