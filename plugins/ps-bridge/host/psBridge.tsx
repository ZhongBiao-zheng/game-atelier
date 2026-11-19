/**
 * PS 联动插件的宿主分块（ADR-0041）。插件启用时画布与设置页才 import 这个文件。
 *
 * 两个画布入口（添加菜单）把 PS 里的选区取成图片节点；图片「更多」里的入口把图片发回 PS。
 * 同一时刻只处理一个请求：处理期间入口置灰，服务端也只放行一个。
 */
import type { HostPluginApi, HostPluginBusy, HostPluginModule } from '@/plugin-host/hostPlugins';
import type { CanvasContentNode } from '@/schema/canvas';

import { importFromPhotoshop, placeInPhotoshop, type PsImportScope } from './api';
import { PsBridgeSettingsArea } from './PsBridgeSettings';

let busy = false;
const listeners = new Set<() => void>();

function setBusy(value: boolean) {
  busy = value;
  for (const listener of listeners) listener();
}

export const psBridgeBusy: HostPluginBusy = {
  get: () => busy,
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

async function exclusive(api: HostPluginApi, work: () => Promise<void>) {
  if (busy) return;
  setBusy(true);
  api.clearError();
  try {
    await work();
  } catch (error) {
    api.reportError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

export function importImage(api: HostPluginApi, position: { x: number; y: number }, scope: PsImportScope) {
  return exclusive(api, async () => {
    // 服务端新建节点会让画布文档换版本：先把本页还没保存的编辑落盘，免得被重载覆盖。
    await api.savePendingEdits();
    const { node_id: nodeId, title } = await importFromPhotoshop(api.projectId, scope);
    if (await api.waitForDocument(document => document.nodes.some(node => node.id === nodeId))) {
      api.updateNode(nodeId, node => ({ ...node, position }));
      api.selectNode(nodeId);
    }
    api.announce(`已从 Photoshop 取回：${title}`);
  });
}

export function placeImage(api: HostPluginApi, node: CanvasContentNode) {
  return exclusive(api, async () => {
    await api.savePendingEdits();
    const result = await placeInPhotoshop(api.projectId, node.id);
    api.announce(result.document ? `已发到 Photoshop：${result.document}` : '已发到 Photoshop');
  });
}

export const plugin: HostPluginModule = {
  nodeTypes: {},
  imageActions: { place: (node, api) => { void placeImage(api, node); } },
  canvasActions: {
    import_merged: (api, position) => { void importImage(api, position, 'merged'); },
    import_layer: (api, position) => { void importImage(api, position, 'layer'); },
  },
  busy: psBridgeBusy,
  Settings: PsBridgeSettingsArea,
};
