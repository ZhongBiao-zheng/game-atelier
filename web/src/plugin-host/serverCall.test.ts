import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginServerError } from './broker';
import { callPluginRoute } from './serverCall';

const call = { pluginId: 'frames', pluginName: '序列帧', projectId: 'canvas-1', nodeId: 'plugin-1', path: '/probe',
  params: {}, versionIds: ['v1'] };

afterEach(() => { vi.unstubAllGlobals(); });

describe('插件服务端调用', () => {
  it('先把未保存的编辑落盘，再发请求（刚建的节点要先存到服务端）', async () => {
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('fetch');
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const result = await callPluginRoute({ ...call, savePendingEdits: async () => { order.push('save'); } });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['save', 'fetch']);
  });

  it('保存失败时不发请求，给一句能看懂的原因', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(callPluginRoute({ ...call, savePendingEdits: async () => { throw new Error('409'); } }))
      .rejects.toBeInstanceOf(PluginServerError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
