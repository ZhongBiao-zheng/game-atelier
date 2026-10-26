import { afterEach, expect, it, vi } from 'vitest';
import * as http from './http';
import { fetchAgentStatus, enableAgent, disableAgent } from './agentConnection';
import { fetchGateway, updateGateway } from './gateway';
import { subscribeGatewayEvents } from './gatewayEvents';

afterEach(() => vi.restoreAllMocks());

import { ApiError, apiError } from './http';

it('preserves a stable server error code and recovery instruction', async () => {
  const response = new Response(JSON.stringify({
    detail: {
      code: 'result_node_missing',
      message: '原生成使用的输入版本已经不存在',
      recovery: '检查历史输入，或按当前设置再次生成。',
    },
  }), { status: 409, statusText: 'Conflict' });

  const error = await apiError(response, '按当前设置再次生成');

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    code: 'result_node_missing',
    status: 409,
    reason: '原生成使用的输入版本已经不存在',
    recovery: '检查历史输入，或按当前设置再次生成。',
  });
  expect(error.message).toContain('原生成使用的输入版本已经不存在');
});

it('shows connection boundary failures without leaking diagnostic metadata', async () => {
  const response = new Response(JSON.stringify({
    error: {
      code: 'ORIGIN_DENIED',
      message: '此来源尚未获准连接本机',
      request_id: 'request-for-local-diagnostics',
    },
  }), { status: 403 });

  const error = await apiError(response, '读取项目');
  expect(error).toMatchObject({
    status: 403, code: 'ORIGIN_DENIED', reason: '此来源尚未获准连接本机', recovery: null,
  });
  expect(error.message).not.toContain('request-for-local-diagnostics');
  expect(error.message).not.toContain('{');
});


it('parses actual Agent paths and tool metadata on read, enable and disable', async () => {
  const status = { enabled: true, connections: { codex: '2026-10-25' },
    config_paths: { 'claude-code': '/data/.config/connections/agent.json', codex: '/custom/config.toml' },
    tools: [{ name: 'canvas_run', billable: true }, { name: 'canvas_get_document', billable: false }] };
  vi.spyOn(http, 'requestJson').mockResolvedValue(status);
  for (const request of [fetchAgentStatus, enableAgent, disableAgent]) {
    expect(await request()).toEqual(status);
  }
});

it.each([
  { enabled: true, connections: {} },
  { enabled: true, connections: [], config_paths: {}, tools: [] },
  { enabled: true, connections: {}, config_paths: { codex: 1 }, tools: [] },
  { enabled: true, connections: {}, config_paths: {}, tools: [{ name: 'canvas_run', billable: 'yes' }] },
  { enabled: true, connections: {}, config_paths: {}, tools: [null] },
])('rejects malformed Agent status without crashing the page', async status => {
  vi.spyOn(http, 'requestJson').mockResolvedValue(status);
  await expect(fetchAgentStatus()).rejects.toThrow('读取 Agent 连接失败：返回格式不对');
});


it('only successful gateway updates publish a refresh, reads and failures do not', async () => {
  const state = { enabled: true, keys: [], port: 5180, status: { running: true } };
  const request = vi.spyOn(http, 'requestJson').mockResolvedValue(state);
  const onConnect = vi.fn();
  const unsubscribe = subscribeGatewayEvents({ onConnect, onTask: vi.fn() });
  try {
    expect(await fetchGateway()).toEqual(state);
    expect(onConnect).not.toHaveBeenCalled();
    expect(await updateGateway({ enabled: true })).toEqual(state);
    expect(onConnect).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error('port unavailable'));
    await expect(updateGateway({ port: 5190 })).rejects.toThrow('port unavailable');
    request.mockResolvedValueOnce({});
    await expect(updateGateway({ enabled: false })).rejects.toThrow('返回格式不对');
    expect(onConnect).toHaveBeenCalledTimes(1);
  } finally { unsubscribe(); }
});
