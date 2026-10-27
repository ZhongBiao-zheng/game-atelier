import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from character_workflow.lib import chatgpt_auth as auth
from character_workflow.lib.callers import chatgpt_image as caller


def jwt(**claims):
    return 'header.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.sig'


def login(expiry=None):
    path = auth.auth_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    value = {'auth_mode': 'chatgpt', 'keep': 'unrelated', 'tokens': {
        'access_token': jwt(exp=expiry if expiry is not None else time.time() + 3600),
        'refresh_token': 'refresh-old', 'account_id': 'account',
        'id_token': jwt(email='fixture@example.test', **{
            'https://api.openai.com/auth': {'chatgpt_plan_type': 'plus'}})}}
    path.write_text(json.dumps(value))
    return path, value


def response(status=200, value=None):
    return SimpleNamespace(status_code=status, text='upstream', json=lambda: value)


def test_status_is_read_only_and_safe(monkeypatch):
    assert auth.get_auth_status() == {'available': False, 'email': None, 'plan': None}
    path, value = login(0)
    post = Mock()
    monkeypatch.setattr(auth.requests, 'post', post)
    assert auth.get_auth_status() == {'available': True, 'email': 'fixture@example.test', 'plan': 'plus'}
    post.assert_not_called()
    assert json.loads(path.read_text()) == value
    assert 'refresh-old' not in repr(auth.get_auth_status())


def test_auth_isolates_real_home_and_refreshes_under_lock(tmp_path, monkeypatch):
    real = tmp_path / 'fake-real-home'
    (real / '.codex').mkdir(parents=True)
    protected = real / '.codex' / 'auth.json'
    protected.write_text('do not touch')
    monkeypatch.setattr(Path, 'home', lambda: real)
    path, value = login(0)
    held = []

    @contextmanager
    def lock(lock_path):
        assert str(lock_path).startswith(os.environ['GAME_ATELIER_DATA_ROOT'])
        held.append(True)
        yield
        held.pop()

    monkeypatch.setattr(auth, 'file_lock', lock)
    new_access = jwt(exp=time.time() + 4000)

    def post(url, **kwargs):
        assert held
        assert kwargs['allow_redirects'] is False
        assert url == 'https://auth.openai.com/oauth/token'
        assert kwargs['json']['refresh_token'] == 'refresh-old'
        return response(value={'access_token': new_access, 'refresh_token': 'refresh-new'})

    monkeypatch.setattr(auth.requests, 'post', post)
    credentials = auth.get_credentials()
    assert credentials.access_token == new_access
    assert 'refresh' not in repr(credentials)
    saved = json.loads(path.read_text())
    assert saved['keep'] == value['keep']
    assert saved['tokens']['refresh_token'] == 'refresh-new'
    assert protected.read_text() == 'do not touch'
    if os.name != 'nt':
        assert path.stat().st_mode & 0o777 == 0o600


def test_refresh_rechecks_after_lock(monkeypatch):
    path, value = login(0)

    @contextmanager
    def lock(_):
        value['tokens']['access_token'] = jwt(exp=time.time() + 5000)
        path.write_text(json.dumps(value))
        yield

    monkeypatch.setattr(auth, 'file_lock', lock)
    post = Mock()
    monkeypatch.setattr(auth.requests, 'post', post)
    assert auth.get_credentials().access_token == value['tokens']['access_token']
    post.assert_not_called()


def test_refresh_does_not_overwrite_external_rotation(monkeypatch):
    path, value = login(0)

    def post(*args, **kwargs):
        value['tokens']['access_token'] = jwt(exp=time.time() + 6000)
        value['tokens']['refresh_token'] = 'cli-new'
        path.write_text(json.dumps(value))
        return response(value={'access_token': 'stale', 'refresh_token': 'stale'})

    monkeypatch.setattr(auth.requests, 'post', post)
    assert auth.get_credentials().access_token == value['tokens']['access_token']
    assert json.loads(path.read_text())['tokens']['refresh_token'] == 'cli-new'


@pytest.mark.parametrize('status', [400, 401, 403])
def test_refresh_failure_never_writes_tokens(monkeypatch, status):
    path, value = login(0)
    monkeypatch.setattr(auth.requests, 'post', lambda *a, **kw: response(status))
    with pytest.raises(auth.ChatGPTAuthError, match=auth.LOGIN_EXPIRED):
        auth.get_credentials()
    assert json.loads(path.read_text()) == value


@pytest.fixture
def image_setup(monkeypatch):
    monkeypatch.setattr(caller.keys, 'find_by_alias', lambda _: SimpleNamespace(provider='chatgpt'))
    monkeypatch.setattr(auth, 'get_credentials', lambda: auth.Credentials('private-token', 'account'))
    monkeypatch.setattr(caller, '_codex_version', lambda: '0.162.1')
    monkeypatch.setattr(caller.openai_image, '_write_outputs', lambda p, d: [str(d / 'v1.png')])
    monkeypatch.setattr(caller.time, 'sleep', lambda _: None)


def test_generation_headers_and_minimal_payload(tmp_path, monkeypatch, image_setup):
    post = Mock(return_value=response(value={'data': []}))
    monkeypatch.setattr(caller.requests, 'post', post)
    caller.render(prompt='fixture', model='gpt-image-2', alias='sub', output_dir=tmp_path,
                  size='auto', params={'quality': 'high', 'background': 'transparent'})
    args, kwargs = post.call_args
    assert args[0].endswith('/images/generations')
    assert kwargs['json'] == {'prompt': 'fixture', 'model': 'gpt-image-2', 'n': 1}
    assert kwargs['allow_redirects'] is False
    headers = kwargs['headers']
    assert headers['Authorization'] == 'Bearer private-token'
    assert headers['chatgpt-account-id'] == 'account'
    assert headers['originator'] == 'codex_cli_rs'
    assert headers['version'] == '0.162.1'
    assert headers['User-Agent'].startswith('codex_cli_rs/0.162.1')
    assert headers['OpenAI-Beta'] == 'responses=experimental'
    assert headers['Accept'] == 'application/json'
    assert len(headers['x-codex-imagegen-request-id']) == 36
    assert headers['x-codex-image-turn-id'] != headers['x-codex-imagegen-request-id']


def test_edit_is_json_data_urls(tmp_path, monkeypatch, image_setup):
    ref = tmp_path / 'source.png'
    ref.write_bytes(b'fixture-image')
    post = Mock(return_value=response(value={'data': []}))
    monkeypatch.setattr(caller.requests, 'post', post)
    caller.render(prompt='edit', model='gpt-image-2', alias='sub', output_dir=tmp_path,
                  params={'source_image': str(ref), 'reference_images': [str(ref)]})
    args, kwargs = post.call_args
    assert args[0].endswith('/images/edits')
    assert 'files' not in kwargs
    assert kwargs['json']['images'] == [{'image_url': 'data:image/png;base64,' +
                                         base64.b64encode(b'fixture-image').decode()}]


@pytest.mark.parametrize(('status', 'message'), [(401, auth.LOGIN_EXPIRED), (403, caller.FORBIDDEN)])
def test_generation_auth_errors(tmp_path, monkeypatch, image_setup, status, message):
    from character_workflow.lib.job_runner import _friendly_error
    from character_workflow.lib.model_routes import failover_reason
    post = Mock(return_value=response(status))
    monkeypatch.setattr(caller.requests, 'post', post)
    with pytest.raises(RuntimeError) as error:
        caller.render(prompt='x', model='gpt-image-2', alias='sub', output_dir=tmp_path)
    assert _friendly_error(error.value) == message
    assert failover_reason(error.value) == 'auth'
    assert post.call_count == 1


@pytest.mark.parametrize(('status', 'count'), [(502, 3), (503, 3), (504, 3), (500, 1), (429, 1)])
def test_retry_rules(monkeypatch, image_setup, status, count):
    post = Mock(return_value=response(status))
    monkeypatch.setattr(caller.requests, 'post', post)
    with pytest.raises(RuntimeError):
        caller._post('https://example.test', {}, 30)
    assert post.call_count == count
    ids = [c.kwargs['headers']['x-codex-imagegen-request-id'] for c in post.call_args_list]
    assert len(set(ids)) == count


def test_read_timeout_never_resubmits(monkeypatch, image_setup):
    from character_workflow.lib.model_routes import failover_reason
    post = Mock(side_effect=requests.ReadTimeout('secret server details'))
    monkeypatch.setattr(caller.requests, 'post', post)
    with pytest.raises(RuntimeError, match='网络') as error:
        caller._post('https://example.test', {}, 30)
    assert post.call_count == 1
    assert failover_reason(error.value) is None
