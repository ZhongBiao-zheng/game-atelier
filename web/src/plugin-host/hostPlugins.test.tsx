import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import storyboardLock from '../../../plugins/storyboard/package/manifest.lock.json';
import type { PluginPackageLock } from '@/schema/plugins';

import { currentHostNodeType, isHostPluginId, useHostPlugins } from './hostPlugins';
import { setPluginsSnapshot } from './registry';

const lock = storyboardLock as unknown as PluginPackageLock;
const node = {
  id: 'plugin-1', type: 'plugin' as const, title: '分镜', position: { x: 0, y: 0 }, z_index: 0,
  data: { plugin_id: 'storyboard', node_type: 'board', plugin_version: '0.1.0', data_schema_version: 1, payload: {}, generation_draft: null },
};

afterEach(() => { act(() => setPluginsSnapshot([])); });

it('only allowlisted host plugins are loaded in the host page', () => {
  expect(isHostPluginId('storyboard')).toBe(true);
  expect(isHostPluginId('pixel')).toBe(false);
  expect(isHostPluginId('constructor')).toBe(false);
});

it('loads a host plugin only while it is enabled and drops it when disabled', async () => {
  setPluginsSnapshot([{ id: lock.id, availability: 'ok', reason: null, enabled: false, manifest: null }]);
  const { result, rerender } = renderHook(() => useHostPlugins());
  expect(result.current.size).toBe(0);
  expect(currentHostNodeType(node)).toBeNull();

  act(() => setPluginsSnapshot([{ id: lock.id, availability: 'ok', reason: null, enabled: true, manifest: lock }]));
  await waitFor(() => expect(result.current.get('storyboard')?.nodeTypes.board).toBeTruthy(), { timeout: 15000 });
  expect(currentHostNodeType(node)).not.toBeNull();

  act(() => setPluginsSnapshot([{ id: lock.id, availability: 'ok', reason: null, enabled: false, manifest: null }]));
  rerender();
  expect(result.current.size).toBe(0);
  expect(currentHostNodeType(node)).toBeNull();
  // 插件包按需加载，Windows CI 上要 3–5 秒；用例时限必须不短于上面 waitFor 的 15 秒。
}, 20000);

it('a sandbox plugin that claims runtime host is not rendered by the host', () => {
  const impostor = { ...lock, id: 'pixel', runtime: 'host' as const };
  setPluginsSnapshot([{ id: 'pixel', availability: 'ok', reason: null, enabled: true, manifest: impostor }]);
  const { result } = renderHook(() => useHostPlugins());
  expect(result.current.size).toBe(0);
  expect(currentHostNodeType({ ...node, data: { ...node.data, plugin_id: 'pixel' } })).toBeNull();
});
