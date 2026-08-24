import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import {
  normalizeStudioSizeForModel,
  studioSizeFor,
  type Resolution,
} from '@/lib/studioSize';
import type { JobParams } from '@/schema/jobs';
import {
  normalizeAudioFormat,
  normalizeAudioSpeed,
  normalizeAudioVoice,
} from '@/lib/audioGeneration';
import type {
  CanvasContentNode,
  CanvasContentVersion,
  CanvasDocument,
  CanvasNode,
} from '@/schema/canvas';
import {
  videoControlCaps,
  type VideoControlCaps,
  type VideoQuality,
} from '@/lib/videoControlCaps';

export function canvasNodeAcceptsInput(node: CanvasNode) {
  return node.type !== 'group' && node.type !== 'plugin';
}

export function canvasNodeProvidesContent(node: CanvasNode): node is CanvasContentNode {
  return node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio';
}

export function canvasNodeHasCurrentContent(
  node: CanvasNode,
  versions: Readonly<Record<string, CanvasContentVersion>>,
): node is CanvasContentNode {
  if (!canvasNodeProvidesContent(node) || !node.data.current_version_id) return false;
  return versions[node.data.current_version_id]?.kind === node.type;
}

export function canCreateCanvasInputConnection(
  document: CanvasDocument | null,
  connection: { source: string | null; target: string | null },
) {
  if (!document || !connection.source || !connection.target || connection.source === connection.target) {
    return false;
  }
  const source = document.nodes.find(node => node.id === connection.source);
  const target = document.nodes.find(node => node.id === connection.target);
  if (
    !source
    || !target
    || !canvasNodeHasCurrentContent(source, document.content_versions)
    || !canvasNodeAcceptsInput(target)
  ) {
    return false;
  }
  return !document.connections.some(edge => (
    edge.role === 'input'
    && edge.source_node_id === connection.source
    && edge.target_node_id === connection.target
  ));
}

export function closestCanvasConnectionEndpoint(
  pointer: { x: number; y: number },
  nodes: ReadonlyArray<{
    id: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>,
  side: 'left' | 'right',
  maximumDistance = 32,
) {
  let nearest: { id: string; distance: number } | null = null;
  for (const node of nodes) {
    const besideNode = side === 'left' ? pointer.x < node.left : pointer.x > node.right;
    const alignedWithHandle = pointer.y >= node.top && pointer.y <= node.bottom;
    if (!besideNode || !alignedWithHandle) continue;
    const distance = Math.min(
      Math.abs(node.left - pointer.x),
      Math.abs(node.right - pointer.x),
    );
    if (distance <= maximumDistance && (!nearest || distance < nearest.distance)) {
      nearest = { id: node.id, distance };
    }
  }
  return nearest?.id ?? null;
}

export function canvasConnectionCreationCapabilities(sourceHandle: 'source' | 'target') {
  return sourceHandle === 'target'
    ? { allowEmptyNodes: false, allowUpload: true }
    : { allowEmptyNodes: true, allowUpload: false };
}

export function normalizeCanvasImageParams(
  model: string,
  provider: string | null | undefined,
  current: JobParams,
  protocol?: string | null,
): JobParams {
  const caps = imageControlCaps(model, provider, protocol);
  const {
    quality: currentQuality,
    background: currentBackground,
    reference_images: _referenceImages,
    reference_videos: _referenceVideos,
    reference_audios: _referenceAudios,
    resolution: _resolution,
    size: _size,
    ...retained
  } = current;
  const currentRatio = String(current.ratio ?? '');
  const ratio = caps.ratios.includes(currentRatio) ? currentRatio : caps.ratios[0];
  const n = caps.family === 'midjourney'
    ? MJ_IMAGES_PER_TASK
    : Math.max(1, Math.min(4, Number(current.n) || 1));
  const params: JobParams = { ...retained, n, ratio };

  if (caps.showResolution && caps.resolutions.length) {
    params.resolution = caps.resolutions.includes(current.resolution as Resolution)
      ? current.resolution
      : caps.resolutions[0];
  }
  if (caps.qualities?.length) {
    params.quality = caps.qualities.includes(currentQuality as Quality)
      ? currentQuality
      : caps.qualities[0];
  }
  if (caps.supportsTransparentBackground
    && ['auto', 'opaque', 'transparent'].includes(String(currentBackground))) {
    params.background = currentBackground;
  }
  if (caps.sizeKind === 'ratio') {
    params.size = ratio;
  } else if (caps.sizeKind === 'pixels') {
    const resolution = (params.resolution as Resolution | undefined) ?? '2K';
    const currentPixelSize = typeof current.size === 'string' && /^\d+x\d+$/.test(current.size)
      ? current.size
      : null;
    params.size = normalizeStudioSizeForModel(
      currentPixelSize ?? studioSizeFor(ratio, resolution, model),
      model,
    );
  }
  return params;
}

export function supportsCanvasTextReasoning(protocol: string | null | undefined) {
  return protocol === 'openai-responses';
}

export function supportsCanvasTextGeneration(
  provider: string | null | undefined,
  protocol: string | null | undefined,
) {
  const supportedProtocols = [null, undefined, 'openai', 'openai-chat', 'chat-completions', 'openai-responses'];
  const declared = protocol != null && supportedProtocols.includes(protocol);
  return supportedProtocols.includes(protocol)
    && (['openai', 'openrouter', 'tokendance', 'custom'].includes(String(provider)) || declared);
}

export function normalizeCanvasTextParams(
  protocol: string | null | undefined,
  current: JobParams,
): JobParams {
  const n = Math.max(1, Math.min(4, Number(current.n) || 1));
  const params: JobParams = { n };
  if (typeof current.temperature === 'number' && protocol !== 'openai-responses') {
    params.temperature = current.temperature;
  }
  if (typeof current.max_tokens === 'number') params.max_tokens = current.max_tokens;
  if (
    supportsCanvasTextReasoning(protocol)
    && ['auto', 'low', 'medium', 'high', 'xhigh'].includes(String(current.reasoning_effort))
  ) {
    params.reasoning_effort = current.reasoning_effort;
  }
  return params;
}

export function supportsCanvasAudioGeneration(
  model: string,
  provider: string | null | undefined,
  protocol: string | null | undefined,
) {
  if (['openai', 'openai-speech', 'tts', 'speech'].includes(String(protocol))) return true;
  if (protocol != null || !['openai', 'custom'].includes(String(provider))) return false;
  const normalized = model.toLowerCase();
  if (['asr', 'speech-to-text', 'speech2text', 'whisper'].some(value => normalized.includes(value))) {
    return false;
  }
  return normalized.includes('tts') || normalized.includes('text-to-speech');
}

export function normalizeCanvasAudioParams(
  model: string,
  provider: string | null | undefined,
  protocol: string | null | undefined,
  current: JobParams,
): JobParams {
  if (!supportsCanvasAudioGeneration(model, provider, protocol)) return {};
  const params: JobParams = {
    voice: normalizeAudioVoice(current.voice),
    response_format: normalizeAudioFormat(current.response_format),
    speed: normalizeAudioSpeed(current.speed),
  };
  const instructions = String(current.instructions ?? '').trim();
  if (instructions) params.instructions = instructions;
  return params;
}

export function canvasVideoEditCaps(
  model: string,
  protocol: string | null | undefined,
): VideoControlCaps {
  return videoControlCaps(model, protocol);
}

export function supportsCanvasVideoEdit(
  model: string,
  protocol: string | null | undefined,
): boolean {
  const caps = canvasVideoEditCaps(model, protocol);
  // Canvas Content Version 永远是服务端本地文件；HappyHorse video-edit 只收公网 URL，
  // 不能把“协议支持”冒充成“当前空间可执行”。Seedance 会走项目已有 OSS 中转。
  return caps.supportsReferenceVideo && caps.family !== 'happyhorse';
}

export function normalizeCanvasVideoParams(
  model: string,
  protocol: string | null | undefined,
  current: JobParams,
  editingExistingVideo = false,
): JobParams {
  const caps = canvasVideoEditCaps(model, protocol);
  const {
    duration: currentDuration,
    resolution: currentResolution,
    ratio: currentRatio,
    mode: currentQuality,
    frame_mode: currentFrameMode,
    generate_audio: currentGenerateAudio,
    watermark: currentWatermark,
    reference_images: _referenceImages,
    reference_videos: _referenceVideos,
    reference_audios: _referenceAudios,
    n: _count,
    size: _size,
    quality: _imageQuality,
    mask_image: _mask,
    angle_horizontal: _angleHorizontal,
    angle_pitch: _anglePitch,
    angle_distance: _angleDistance,
    angle_wide: _angleWide,
    voice: _voice,
    speed: _speed,
    response_format: _responseFormat,
    instructions: _instructions,
    temperature: _temperature,
    max_tokens: _maxTokens,
    ...retained
  } = current;
  const params: JobParams = { ...retained };

  if (caps.durations.length) {
    const duration = Number(currentDuration);
    params.duration = caps.durations.includes(duration)
      ? duration
      : caps.durations.includes(5) ? 5 : caps.durations[0];
  }
  if (caps.resolutions.length) {
    params.resolution = caps.resolutions.includes(String(currentResolution))
      ? String(currentResolution)
      : caps.resolutions[0];
  }
  if (caps.ratios.length) {
    params.ratio = caps.ratios.includes(String(currentRatio))
      ? String(currentRatio)
      : caps.ratios.includes('16:9') ? '16:9' : caps.ratios[0];
  }
  if (caps.qualities?.length) {
    params.mode = caps.qualities.includes(currentQuality as VideoQuality)
      ? currentQuality
      : caps.qualities[0];
  }
  if (caps.supportsAudio) {
    params.generate_audio = typeof currentGenerateAudio === 'boolean'
      ? currentGenerateAudio
      : true;
  }
  if (caps.supportsWatermark) {
    params.watermark = typeof currentWatermark === 'boolean' ? currentWatermark : false;
  }
  if (editingExistingVideo) {
    params.frame_mode = 'auto';
  } else if (currentFrameMode) {
    params.frame_mode = currentFrameMode;
  }
  return params;
}
