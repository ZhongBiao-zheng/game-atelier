/**
 * 分镜插件的宿主分块入口（ADR-0039）。插件启用时画布才 import 这个文件。
 *
 * 逐镜生成的规则从画布搬到这里，行为不变：先按当前文档算出生成计划（确认弹窗只显示它），确认后原样应用，
 * 再一镜一镜调用与节点「生成」按钮相同的 Canvas Run；某一镜失败不影响后面的。
 */
import { EditIcon } from '@/components/ui/icons';
import type { HostPluginApi, HostPluginModule, HostPluginNodeProps } from '@/plugin-host/hostPlugins';
import type { CanvasContentNode, CanvasDocument, CanvasNode, JsonValue } from '@/schema/canvas';

import {
  STORYBOARD_NODE_TYPE, isStoryboardNode, normalizeStoryboardPayload, remapStoryboardPayload,
} from './canvasStoryboard';
import { StoryboardNodeBody, requestStoryboardEdit, type StoryboardHost } from './StoryboardNodeBody';
import {
  applyShotGenerationPlan, planShotGeneration, rebindShotResult, type ShotGenerationKind, type ShotGenerationPlan,
} from './storyboardGeneration';

function isContentNode(node: CanvasNode): node is CanvasContentNode {
  return node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio';
}

/** 按当前文档算一份生成计划。只算不改，确认弹窗显示的就是它。 */
function planShots(api: HostPluginApi, nodeId: string, shotIds: readonly string[], kind: ShotGenerationKind, count: number) {
  const current = api.currentDocument();
  return current ? planShotGeneration({
    document: current, storyboardNodeId: nodeId, shotIds, kind, count,
    deps: { providers: api.providers(), preference: api.generationDefault(kind), newId: api.newId },
  }) : null;
}

/** 应用确认过的计划，再一镜一镜提交；每镜是一次独立的 Canvas Run，某一镜失败不影响后面的。 */
async function runShots(api: HostPluginApi, plan: ShotGenerationPlan) {
  const current = api.currentDocument();
  if (!current) return;
  const { nodeIds } = applyShotGenerationPlan(current, plan);
  if (nodeIds.length === 0) return;
  api.commitDocument(document => applyShotGenerationPlan(document, plan).document, true);
  // 画布状态经 React 更新后才进最新文档：每一步都等它落定，
  // 否则下一镜提交前的保存会带着旧文档，把上一镜的运行状态盖掉。
  const nodeOf = (document: CanvasDocument, id: string) => document.nodes.find(node => node.id === id);
  if (!await api.waitForDocument(document => nodeIds.every(id => nodeOf(document, id)))) return;
  for (const nodeId of nodeIds) {
    const before = nodeOf(api.currentDocument()!, nodeId);
    const versionBefore = before && isContentNode(before) ? before.data.current_version_id : null;
    // 保存没完成、或服务端版本刚被上一镜的结果推进（409）时，这一镜确定没有发出去：等一下再提交。
    // 其它错误结果不明，不再提交，继续下一镜。
    let outcome = await api.submitRun(nodeId);
    for (let attempt = 0; attempt < 3 && (outcome.status === 'not_sent' || outcome.status === 'conflict'); attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 600));
      outcome = await api.submitRun(nodeId);
    }
    if (outcome.status !== 'submitted') continue;
    api.clearError();
    const resultId = outcome.resultNodeId ?? nodeId;
    // 提交成功后结果节点会带上运行状态（或已经出了新内容）；等它进了本地文档再提交下一镜。
    await api.waitForDocument(document => {
      const node = nodeOf(document, resultId);
      return Boolean(node) && (!isContentNode(node!) || Boolean(node!.data.active_run_id) || node!.data.current_version_id !== versionBefore);
    });
    // 在已有内容的节点上重新生成，结果会落到一个新节点：让这一镜改绑到新结果，并沿用镜头的标题。
    const item = plan.items.find(candidate => candidate.nodeId === nodeId);
    if (item && resultId !== nodeId) {
      api.commitDocument(document => rebindShotResult(document, plan, item.shotId, resultId, before?.title ?? ''), false);
      await api.waitForDocument(document => nodeOf(document, resultId)?.title === (before?.title ?? ''));
    }
  }
}

function storyboardHost(api: HostPluginApi): StoryboardHost {
  return {
    projectId: api.projectId, findNode: api.findNode, resolveVersion: api.resolveVersion,
    updateNode: api.updateNode, recordHistory: api.recordHistory, selectNode: api.selectNode,
    reportError: api.reportError, savePendingEdits: api.savePendingEdits, listNodes: api.listNodes,
    planShots: (nodeId, shotIds, kind, count) => planShots(api, nodeId, shotIds, kind, count),
    runShots: plan => runShots(api, plan),
    lastRunFailed: api.lastRunFailed,
  };
}

function Body({ node, api }: HostPluginNodeProps) {
  return isStoryboardNode(node) ? <StoryboardNodeBody node={node} host={storyboardHost(api)} /> : null;
}

export const plugin: HostPluginModule = {
  nodeTypes: {
    [STORYBOARD_NODE_TYPE]: {
      create: (shell, sourceNodeId) => ({
        ...shell,
        data: {
          ...shell.data,
          payload: normalizeStoryboardPayload({ script_node_ids: sourceNodeId ? [sourceNodeId] : [] }) as unknown as JsonValue,
        },
      }),
      Body,
      toolbar: node => [{ id: 'edit', label: `编辑 ${node.title}`, text: '编辑', Icon: EditIcon, onClick: () => requestStoryboardEdit(node.id) }],
      openPanel: nodeId => requestStoryboardEdit(nodeId, 'script'),
      remapPayload: remapStoryboardPayload,
      textContent: true,
    },
  },
};
