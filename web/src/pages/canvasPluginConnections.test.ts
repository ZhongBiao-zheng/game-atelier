import { afterEach, describe, expect, it } from 'vitest';

import lockFixture from '../../../plugins/sprite-sheet/package/manifest.lock.json';
import { setPluginsSnapshot } from '@/plugin-host/registry';
import type { CanvasDocument, CanvasNode } from '@/schema/canvas';
import type { PluginEntry, PluginPackageLock } from '@/schema/plugins';
import { canCreateCanvasInputConnection, canvasNodeAcceptsInput } from './canvasEditorModel';

const manifest = lockFixture as unknown as PluginPackageLock;
const enable = (enabled = true) => setPluginsSnapshot(
  [{ id: 'sprite-sheet', availability: 'ok', reason: null, enabled, manifest } satisfies PluginEntry]);

const content = (id: string, type: 'image' | 'text'): CanvasNode => ({
  id, type, title: id, position: { x: 0, y: 0 }, z_index: 0,
  data: { current_version_id: null, generation_draft: null, active_run_id: null,
    display: type === 'text' ? { scale: 'sm' } : { fit: 'contain', free_resize: false } },
} as unknown as CanvasNode);
const sheet = (nodeType = 'sheet'): CanvasNode => ({
  id: 'sheet', type: 'plugin', title: '精灵表', position: { x: 0, y: 0 }, z_index: 0,
  data: { plugin_id: 'sprite-sheet', node_type: nodeType, plugin_version: '0.1.0', data_schema_version: 1,
    payload: {}, generation_draft: null },
});
const doc = (nodes: CanvasNode[], edges: Array<[string, string]> = []) => ({
  nodes, connections: edges.map(([source, target]) => (
    { id: `${source}-${target}`, role: 'input', source_node_id: source, target_node_id: target })),
} as unknown as CanvasDocument);

afterEach(() => setPluginsSnapshot([]));

describe('插件节点的连接判定', () => {
  it('已启用且清单声明了输入类型时接收输入', () => {
    enable();
    expect(canvasNodeAcceptsInput(sheet())).toBe(true);
    expect(canCreateCanvasInputConnection(doc([content('img', 'image'), sheet()]), { source: 'img', target: 'sheet' })).toBe(true);
  });

  it('插件未启用或不存在时不接新连线', () => {
    enable(false);
    expect(canvasNodeAcceptsInput(sheet())).toBe(false);
    expect(canCreateCanvasInputConnection(doc([content('img', 'image'), sheet()]), { source: 'img', target: 'sheet' })).toBe(false);
    setPluginsSnapshot([]);
    expect(canvasNodeAcceptsInput(sheet())).toBe(false);
  });

  it('清单里没有的节点类型不接输入', () => {
    enable();
    expect(canvasNodeAcceptsInput(sheet('ghost'))).toBe(false);
  });

  it('只收清单声明的素材类型', () => {
    enable();
    expect(canCreateCanvasInputConnection(doc([content('txt', 'text'), sheet()]), { source: 'txt', target: 'sheet' })).toBe(false);
  });

  it('不超过清单的输入上限，也不重复连接', () => {
    enable();
    const nodes = [content('a', 'image'), content('b', 'image'), sheet()];
    expect(canCreateCanvasInputConnection(doc(nodes, [['a', 'sheet']]), { source: 'b', target: 'sheet' })).toBe(false);
    expect(canCreateCanvasInputConnection(doc(nodes, [['a', 'sheet']]), { source: 'a', target: 'sheet' })).toBe(false);
  });

  it('插件节点不能作为输入来源', () => {
    enable();
    expect(canCreateCanvasInputConnection(doc([sheet(), content('img', 'image')]), { source: 'sheet', target: 'img' })).toBe(false);
  });
});
