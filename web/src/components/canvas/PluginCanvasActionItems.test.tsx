import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { setPluginsSnapshot } from '@/plugin-host/registry';
import type { PluginPackageLock } from '@/schema/plugins';
import spriteLock from '../../../../plugins/sprite-sheet/package/manifest.lock.json';
import storyboardLock from '../../../../plugins/storyboard/package/manifest.lock.json';

import { PluginCanvasActionItems } from './CanvasEditorViews';

const action = { id: 'fetch', label: '取回来', icon: 'grid', action: { kind: 'host_call' as const } };

function hostPlugin(): PluginPackageLock {
  // 白名单里的宿主插件（借 storyboard 的 id）在添加菜单里声明一个调用型入口。
  const base = storyboardLock as unknown as PluginPackageLock;
  return { ...base, contributes: { ...base.contributes, canvas_actions: [action] } };
}

it('lists canvas actions of enabled host plugins and runs them', () => {
  const plugin = hostPlugin();
  const onRun = vi.fn();
  setPluginsSnapshot([{ id: plugin.id, availability: 'ok', reason: null, enabled: false, manifest: plugin }]);
  const { rerender } = render(<PluginCanvasActionItems hostPlugins={new Map()} onRun={onRun} />);
  expect(screen.queryByRole('menuitem', { name: /取回来/ })).toBeNull();

  act(() => setPluginsSnapshot([{ id: plugin.id, availability: 'ok', reason: null, enabled: true, manifest: plugin }]));
  rerender(<PluginCanvasActionItems hostPlugins={new Map()} onRun={onRun} />);
  fireEvent.click(screen.getByRole('menuitem', { name: /取回来/ }));
  expect(onRun).toHaveBeenCalledWith(plugin, action);
  act(() => setPluginsSnapshot([]));
});

it('disables canvas actions while the host plugin is busy', () => {
  const plugin = hostPlugin();
  let busy = true;
  const listeners = new Set<() => void>();
  const module = {
    nodeTypes: {},
    busy: { get: () => busy, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
  };
  setPluginsSnapshot([{ id: plugin.id, availability: 'ok', reason: null, enabled: true, manifest: plugin }]);
  render(<PluginCanvasActionItems hostPlugins={new Map([[plugin.id, module]])} onRun={vi.fn()} />);
  expect(screen.getByRole('menuitem', { name: /取回来/ })).toBeDisabled();
  act(() => { busy = false; listeners.forEach(listener => listener()); });
  expect(screen.getByRole('menuitem', { name: /取回来/ })).toBeEnabled();
  act(() => setPluginsSnapshot([]));
});

it('shows no canvas actions for plugins outside the host allowlist', () => {
  const base = spriteLock as unknown as PluginPackageLock;
  const plugin: PluginPackageLock = { ...base, runtime: 'host', contributes: { ...base.contributes, canvas_actions: [action] } };
  setPluginsSnapshot([{ id: plugin.id, availability: 'ok', reason: null, enabled: true, manifest: plugin }]);
  render(<PluginCanvasActionItems hostPlugins={new Map()} onRun={vi.fn()} />);
  expect(screen.queryByRole('menuitem', { name: /取回来/ })).toBeNull();
  act(() => setPluginsSnapshot([]));
});
