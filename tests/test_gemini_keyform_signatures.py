"""改名 Gemini 模型读图后的签名回放：真实 SDK + 进程内假上游。"""
import asyncio
import json

import pytest

from character_workflow.lib import canvas_agent_vision as vision
from character_workflow.lib.llm_protocols import gemini
from tests.test_llm_protocols_gemini_agent import (
    SIG, _Upstream, _agent, _drain, _function_calls, _gem_calls, _gem_text,
)


@pytest.mark.parametrize('parallel', [False, True])
@pytest.mark.parametrize('model', ['relay-alias', 'gemini-test'])
def test_image_followup_replays_real_signature_with_parallel_calls(model, parallel):
    from agents import RunConfig, Runner, function_tool
    from agents.run_config import ModelInputData

    @function_tool
    def read_media() -> str:
        """Read a local image."""
        return json.dumps({'ok': True, vision.ATTACH_KEY: ['ver-1']})

    @function_tool
    def get_canvas() -> str:
        """Read the canvas."""
        return '{}'

    async def attach(data):
        return ModelInputData(input=vision.with_attached_images(
            list(data.model_data.input), lambda _v: 'data:image/png;base64,AAAA'),
            instructions=data.model_data.instructions)

    async def go():
        calls = [{'name': 'read_media', 'args': {}}]
        if parallel:
            calls.append({'name': 'get_canvas', 'args': {}})
        upstream = _Upstream(_gem_calls(*calls), _gem_text())
        await _drain(Runner.run_streamed(_agent(upstream, [read_media, get_canvas], model),
            '读图并描述', max_turns=4, run_config=RunConfig(call_model_input_filter=attach)))
        assert len(upstream.requests) == 2
        return upstream.requests[1]

    body = asyncio.run(go())
    calls = _function_calls(body)
    assert calls[0]['thoughtSignature'] == SIG
    assert len(calls) == (2 if parallel else 1)
    assert all('thoughtSignature' not in c for c in calls[1:])
    parts = body['contents'][-1]['parts']
    assert {'inlineData': {'mimeType': 'image/png', 'data': 'AAAA'}} in parts
    assert [p['functionResponse']['name'] for p in parts if 'functionResponse' in p] == (
        ['read_media', 'get_canvas'] if parallel else ['read_media'])


def test_alias_image_followup_without_saved_signature_uses_placeholder():
    body = gemini.to_upstream({'model': 'relay-alias', 'messages': [
        {'role': 'user', 'content': '读图'},
        {'role': 'assistant', 'tool_calls': [{'id': 'gsr_previous', 'type': 'function',
            'function': {'name': 'read_media', 'arguments': '{}'}}]},
        {'role': 'tool', 'tool_call_id': 'gsr_previous', 'content': '{}'},
        {'role': 'user', 'content': [{'type': 'text', 'text': '上面工具结果里的图片：'},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAAA'}}]},
    ]})
    assert _function_calls(body)[0]['thoughtSignature'] == gemini.PLACEHOLDER_SIGNATURE
