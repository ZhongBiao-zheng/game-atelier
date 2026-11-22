"""Chat 兼容端点：真实 Runner 收到末尾 usage 后写入 Agent 用量。"""
import pytest

from character_workflow.lib import agent_usage, keys
from tests.fake_http_vendor import FakeVendor
from tests.test_llm_protocols_gemini_agent import _chat, _setup, _turn


@pytest.mark.parametrize('base_path', ['/v1beta/openai', '/v1'])
def test_compatible_stream_requests_and_records_usage(base_path):
    chunk = {'id': 'c', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'gpt-test'}
    with FakeVendor() as vendor:
        path = base_path + '/chat/completions'
        vendor.on('POST', path, _chat(
            {**chunk, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': '完成'},
                                  'finish_reason': 'stop'}]},
            {**chunk, 'choices': [], 'usage': {'prompt_tokens': 123, 'completion_tokens': 17,
                'total_tokens': 140, 'prompt_tokens_details': {'cached_tokens': 20}}}))
        pid, sid = _setup(vendor)
        db = keys.read_keys_db()
        db.keys[0].base_url = vendor.url + base_path
        keys.write_keys_db(db)
        result = _turn(pid, sid, 'gpt-test', '你好')
        assert result.status == 'idle', result.error
        [request] = vendor.calls('POST', path)
        assert request.json()['stream_options'] == {'include_usage': True}
    [row] = agent_usage.read_rows()
    assert (row['input_tokens'], row['output_tokens'], row['cached_tokens']) == (123, 17, 20)
