/**
 * 插件节点的输入：画布连线 → 交给插件的素材列表。
 *
 * 连的是结果组封面时，封面与组内成员按组内顺序一起列出，成员标记 `member`，整组带同一个
 * `groupVersionId`（封面的版本）。节点类型声明了 `expand_result_stack` 才把成员交给插件，
 * 否则只交封面——一条连线默认就是一张图。服务端按同一规则独立核对（plugin_server._surface_inputs）。
 */
import type { CanvasContentVersion, CanvasDocument } from '@/schema/canvas';
import type { PluginNodeContribution } from '@/schema/plugins';
import { canvasNodeProvidesContent } from '@/pages/canvasEditorModel';
import type { BrokerInput } from './broker';

export interface PluginNodeInput {
  nodeId: string;
  title: string;
  versionId: string | null;
  /** 属于结果组时为封面的当前版本 id（封面自己也带）。 */
  groupVersionId?: string | null;
  /** 结果组里除封面以外的成员。 */
  member?: boolean;
}

export function pluginInputsFromDocument(document: CanvasDocument | null | undefined): Map<string, PluginNodeInput[]> {
  const nodes = new Map((document?.nodes ?? []).map(node => [node.id, node]));
  const result = new Map<string, PluginNodeInput[]>();
  for (const connection of document?.connections ?? []) {
    if (connection.role !== 'input' || nodes.get(connection.target_node_id)?.type !== 'plugin') continue;
    const source = nodes.get(connection.source_node_id);
    if (!source || !canvasNodeProvidesContent(source)) continue;
    const inputs = result.get(connection.target_node_id) ?? [];
    const stack = source.type === 'image' ? source.data.result_stack : null;
    const members = (stack?.member_node_ids ?? []).flatMap(id => {
      const member = nodes.get(id);
      return member?.type === 'image' && member.id !== source.id ? [member] : [];
    });
    const groupVersionId = members.length ? source.data.current_version_id : null;
    inputs.push({ nodeId: source.id, title: source.title, versionId: source.data.current_version_id,
      ...(groupVersionId ? { groupVersionId } : {}) });
    for (const member of members) {
      inputs.push({ nodeId: member.id, title: member.title, versionId: member.data.current_version_id,
        groupVersionId, member: true });
    }
    result.set(connection.target_node_id, inputs);
  }
  return result;
}

/** 交给 broker 的输入：按清单过滤素材类型与结果组成员，同一版本只列一次。 */
export function brokerInputsFor(
  inputs: readonly PluginNodeInput[],
  contribution: PluginNodeContribution | undefined,
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined,
): BrokerInput[] {
  const expand = Boolean(contribution?.expand_result_stack);
  const seen = new Set<string>();
  return inputs.flatMap(input => {
    if (!expand && input.member) return [];
    const version = resolveVersion(input.versionId);
    if (!version || !input.versionId || seen.has(input.versionId)) return [];
    // 清单没声明要收的素材类型不交给插件，即使文档里有这条连线。
    if (!contribution?.input_modalities.includes(version.kind)) return [];
    seen.add(input.versionId);
    const media = version.kind === 'text' ? null : version;
    return [{
      versionId: input.versionId, kind: version.kind, title: input.title,
      width: media?.width ?? null, height: media?.height ?? null,
      ...(media ? { bytes: media.bytes } : {}),
      ...(expand && input.groupVersionId ? { groupVersionId: input.groupVersionId } : {}),
    }];
  });
}
