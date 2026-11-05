import { canvasMediaUrl, uploadCanvasMedia } from '@/api/canvas';
import type { CanvasConnection, CanvasDocument, CanvasGenerationDraft } from '@/schema/canvas';
import { acceptServerContentVersions } from '@/pages/canvasEditorModel';
import { createConnectedCanvasSurface } from '@/pages/canvasEditorModel';
import { composeAnnotatedImage, composeAnnotationMarkup } from './composeAnnotatedImage';
import { supportsGptImage26 } from '@/lib/imageControlCaps';
export interface AnnotationDocumentBridge {
  projectId: string;
  current: () => CanvasDocument | null;
  revision: () => number;
  setRevision: (revision: number) => void;
  apply: (document: CanvasDocument, record: boolean) => void;
  persist: () => Promise<boolean>;
  busy: () => boolean;
  lock: (locked: boolean) => void;
}
function sourceAnnotation(document: CanvasDocument | null, id: string) {
  const node = document?.nodes.find(node => node.id === id);
  if (node?.type !== 'image' || !node.data.annotation?.elements.length) throw new Error('标注已清空，请断开带标注的连接');
  if (node.data.annotation.version_id !== node.data.current_version_id) throw new Error(`「${node.title}」当前版本没有标注，切回标注所在版本或断开连接`);
  return node.data.annotation;
}
type AnnotationDerivedField = 'rendered_version_id' | 'markup_version_id';
async function ensureAnnotationDerived(bridge: AnnotationDocumentBridge, nodeId: string, field: AnnotationDerivedField) {
  if (bridge.busy()) throw new Error('画布正在处理其他操作，请稍后再试');
  const current = bridge.current(), annotation = sourceAnnotation(current, nodeId);
  const existingId = annotation[field];
  const existing = existingId ? current?.content_versions[existingId] : undefined;
  if (existing?.kind === 'image') return existing.version_id;
  const version = current?.content_versions[annotation.version_id];
  if (version?.kind !== 'image' || !version.width || !version.height) throw new Error('找不到标注原图尺寸');
  const fingerprint = JSON.stringify([annotation.version_id, annotation.elements]);
  bridge.lock(true);
  try {
    const file = field === 'markup_version_id'
      ? await composeAnnotationMarkup(annotation.elements, version.width, version.height)
      : await composeAnnotatedImage(canvasMediaUrl(bridge.projectId, version.version_id), annotation.elements, version.width, version.height);
    const uploaded = await uploadCanvasMedia(bridge.projectId, file, bridge.revision());
    bridge.setRevision(uploaded.document.revision);
    const latest = bridge.current(); if (!latest) throw new Error('画布已关闭');
    // 上传只新增版本；合并到最新草稿，不覆盖合成期间发生的编辑。
    const next = { ...latest, revision: uploaded.document.revision,
      content_versions: acceptServerContentVersions(latest.content_versions, uploaded.document.content_versions) };
    const live = sourceAnnotation(next, nodeId);
    if (JSON.stringify([live.version_id, live.elements]) !== fingerprint) {
      bridge.apply(next, false);
      throw new Error('标注已改变，请重新提交');
    }
    bridge.apply({ ...next, nodes: next.nodes.map(node => node.id === nodeId && node.type === 'image'
      ? { ...node, data: { ...node.data, annotation: { ...live, [field]: uploaded.version.version_id } } } : node) }, false);
    return uploaded.version.version_id;
  } finally { bridge.lock(false); }
}
/** 合成图：原图 + 标注一张 PNG。 */
export function ensureAnnotationRendered(bridge: AnnotationDocumentBridge, nodeId: string) {
  return ensureAnnotationDerived(bridge, nodeId, 'rendered_version_id');
}
/** 标注层：只含标注的透明 PNG（GPT Image 2.6 markup）。 */
export function ensureAnnotationMarkup(bridge: AnnotationDocumentBridge, nodeId: string) {
  return ensureAnnotationDerived(bridge, nodeId, 'markup_version_id');
}
/** 这条带标注连线是否可能按「原图 + 标注层」发送：目标模型有 2.6 能力且连线上没选合成图。
 *  渠道是否真走官方 edits 由服务端判（uses_annotation_markup）；这里多算一张标注层只是多一次上传。 */
export function edgeWantsAnnotationMarkup(document: CanvasDocument | null, edge: CanvasConnection) {
  if (edge.role !== 'input' || !edge.annotated || edge.annotation_delivery === 'composite') return false;
  const node = document?.nodes.find(n => n.id === edge.target_node_id);
  const draft = node && 'generation_draft' in node.data ? node.data.generation_draft : null;
  return !!draft && draft.mode === 'image' && supportsGptImage26(draft.model);
}
export async function ensureAnnotatedInputs(bridge: AnnotationDocumentBridge, targetNodeId: string, upstream = false) {
  const document = bridge.current();
  const targets = new Set([targetNodeId]);
  if (upstream && document) {
    for (const id of targets) {
      const node = document.nodes.find(n => n.id === id);
      if (node?.type === 'group') node.data.member_node_ids.forEach(member => targets.add(member));
      document.connections.forEach(edge => { if (edge.role === 'input' && edge.target_node_id === id) targets.add(edge.source_node_id); });
    }
  }
  const sources = new Set<string>(), markupSources = new Set<string>();
  for (const edge of bridge.current()?.connections ?? []) {
    if (edge.role !== 'input' || !edge.annotated || !targets.has(edge.target_node_id)) continue;
    sources.add(edge.source_node_id);
    if (edgeWantsAnnotationMarkup(bridge.current(), edge)) markupSources.add(edge.source_node_id);
  }
  // 合成图始终准备：服务端在渠道不透传 markup 时会退回合成图，不能到那时才发现没图。
  for (const id of sources) await ensureAnnotationRendered(bridge, id);
  for (const id of markupSources) await ensureAnnotationMarkup(bridge, id);
  if (sources.size && !await bridge.persist()) throw new Error('标注尚未保存，请重试');
}
export async function createAnnotatedGeneration(bridge: AnnotationDocumentBridge, nodeId: string, draft: CanvasGenerationDraft) {
  if (bridge.busy()) throw new Error('画布正在处理其他操作，请稍后再试');
  if (!await bridge.persist()) throw new Error('画布尚未保存，请重试');
  await ensureAnnotationRendered(bridge, nodeId);
  const current = bridge.current(); if (!current) throw new Error('画布已关闭');
  const newId = `image-${crypto.randomUUID()}`;
  const next = createConnectedCanvasSurface(current, nodeId, { ...draft, prompt: '按图中标注修改，输出不保留标注。' },
    { nodeId: newId, connectionId: `connection-${crypto.randomUUID()}` }, 'image', true);
  if (!next) throw new Error('无法创建改图节点');
  bridge.apply(next, true);
  if (!await bridge.persist()) throw new Error('改图节点尚未保存，请重试');
  return newId;
}
