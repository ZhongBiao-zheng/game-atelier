import type { Edge } from '@xyflow/react';
import type { KeyView } from '@/api/keys';
import type { FlowNode } from '@/components/canvas/CanvasEditorViews';
import type { CanvasContentVersion, CanvasGenerationDraft, CanvasGenerationMode, CanvasNode } from '@/schema/canvas';

export type PrototypePipeline = 'video' | 'audio';
export const STEP_LABELS: Record<string, string> = { image: '图片', video: '视频', text: '文案', audio: '配音' };
export const pipelineSteps = (pipeline: PrototypePipeline) => pipeline === 'video' ? ['image', 'video'] : ['image', 'text', 'audio'];

// Fixtures only. There are no credentials and no reads from the user's model configuration.
export const PROTOTYPE_KEYS: KeyView[] = [
  {
    alias: 'prototype-openai', provider: 'openai', base_url: null, access_key: '', secret_key: null,
    capabilities: [], notes: '仅界面演示', created_at: '',
    models: [
      { id: 'gpt-image-2', name: 'GPT Image 2 · 演示', modality: 'image', protocol: 'openai' },
      { id: 'gpt-4.1', name: 'GPT 4.1 · 演示', modality: 'text', protocol: 'openai-chat', input_modalities: ['text', 'image'] },
      { id: 'gpt-4o-mini-tts', name: 'GPT 4o Mini TTS · 演示', modality: 'audio', protocol: 'openai-speech' },
    ],
  },
  {
    alias: 'prototype-video', provider: 'seedance', base_url: null, access_key: '', secret_key: null,
    capabilities: [], notes: '仅界面演示', created_at: '',
    models: [{ id: 'seedance-2.0', name: 'Seedance 2.0 · 演示', modality: 'video', protocol: 'seedance' }],
  },
];

function draft(mode: CanvasGenerationMode, prompt: string): CanvasGenerationDraft {
  const key = PROTOTYPE_KEYS.find(candidate => candidate.models.some(model => model.modality === mode))!;
  return {
    mode, prompt, input_policy: 'all_connected', alias: key.alias,
    model: key.models.find(model => model.modality === mode)!.id,
    params: mode === 'video' ? { n: 1, duration: 5, ratio: '16:9', resolution: '720p', frame_mode: 'auto' }
      : mode === 'image' ? { n: 1, ratio: '1:1', size: '1024x1024', quality: 'low' }
        : mode === 'audio' ? { n: 1, voice: 'alloy', response_format: 'mp3', speed: 1 } : { n: 1 },
    updated_at: '2026-08-31T00:00:00Z',
  };
}

export function createPrototypeCanvas(pipeline: PrototypePipeline) {
  const versions: Record<string, CanvasContentVersion> = {};
  const nodes: FlowNode[] = [];
  const add = (id: string, mode: CanvasGenerationMode, title: string, x: number, y: number, prompt: string, text?: string) => {
    const versionId = mode === 'text' ? `prototype-${id}` : null;
    if (versionId) versions[versionId] = {
      version_id: versionId, kind: 'text', text: text ?? '', sha256: '0'.repeat(64),
      created_at: '2026-08-31T00:00:00Z', origin: { kind: 'user_edit' },
    };
    const common = {
      current_version_id: versionId, active_run_id: null,
      generation_draft: text === undefined ? draft(mode, prompt) : null,
    };
    const base = { id, title, position: { x, y }, size: { width: 300, height: mode === 'text' ? 145 : 195 }, z_index: 0 };
    const domain: CanvasNode = mode === 'text' ? { ...base, type: 'text', data: { ...common, display: { scale: 'sm' } } }
      : mode === 'audio' ? { ...base, type: 'audio', data: common }
        : { ...base, type: mode, data: { ...common, display: { fit: 'contain', free_resize: false } } };
    nodes.push({ id, type: 'canvasNode', position: base.position, style: base.size, data: { domain } });
  };
  add('promptA', 'text', '共用提示词', 475, 30, '', '保留主体与构图，转换成毛绒玩偶，柔和棚拍光。');
  add('image', 'image', '图片生成', 475, 265, '根据参考素材与共用提示词生成图片。');
  if (pipeline === 'video') {
    add('promptB', 'text', '共用镜头描述', 895, 30, '', '角色轻轻转头，镜头缓慢推进，保持形象一致。');
    add('video', 'video', '视频生成', 895, 265, '让本项图片按共用镜头描述动起来。');
  } else {
    add('text', 'text', '文案生成', 865, 265, '根据本项图片写一句自然、有趣的商品介绍。');
    add('audio', 'audio', '音频生成', 1255, 265, '朗读本项文案。');
  }
  const pairs = pipeline === 'video'
    ? [['batch', 'image'], ['promptA', 'image'], ['image', 'video'], ['promptB', 'video']]
    : [['batch', 'image'], ['promptA', 'image'], ['image', 'text'], ['text', 'audio']];
  const edges: Edge[] = pairs.map(([source, target]) => ({
    id: `${source}-${target}`, source, target,
    style: { stroke: 'var(--primary)', strokeWidth: 1.5 },
  }));
  return { nodes, versions, edges };
}
