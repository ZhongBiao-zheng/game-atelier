import { canvasMediaUrl, uploadCanvasMedia } from '@/api/canvas';
import type { CanvasDocument, CanvasGenerationDraft } from '@/schema/canvas';
import { acceptServerContentVersions } from '@/pages/canvasEditorModel';
import { createConnectedCanvasSurface } from '@/pages/canvasEditorModel';
import { composeAnnotatedImage } from './composeAnnotatedImage';
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
export async function ensureAnnotationRendered(bridge: AnnotationDocumentBridge, nodeId: string) {
  if (bridge.busy()) throw new Error('画布正在处理其他操作，请稍后再试');
  const current = bridge.current(), annotation = sourceAnnotation(current, nodeId);
  const rendered = annotation.rendered_version_id ? current?.content_versions[annotation.rendered_version_id] : undefined;
  if (rendered?.kind === 'image') return rendered.version_id;
  const version = current?.content_versions[annotation.version_id];
  if (version?.kind !== 'image' || !version.width || !version.height) throw new Error('找不到标注原图尺寸');
  const fingerprint = JSON.stringify([annotation.version_id, annotation.elements]);
  bridge.lock(true);
  try {
    const file = await composeAnnotatedImage(canvasMediaUrl(bridge.projectId, version.version_id), annotation.elements, version.width, version.height);
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
      ? { ...node, data: { ...node.data, annotation: { ...live, rendered_version_id: uploaded.version.version_id } } } : node) }, false);
    return uploaded.version.version_id;
  } finally { bridge.lock(false); }
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
  const sources = new Set(bridge.current()?.connections.flatMap(edge => edge.role === 'input' && edge.annotated
    && targets.has(edge.target_node_id) ? [edge.source_node_id] : []) ?? []);
  for (const id of sources) await ensureAnnotationRendered(bridge, id);
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
