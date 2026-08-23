import type { Job, JobKind, JobParams } from '@/schema/jobs';
import type { CanvasGenerationNode, CanvasNode } from '@/schema/canvas';

interface CanvasJobBody {
  prompt: string;
  model: string;
  params: JobParams;
  alias?: string;
  kind: JobKind;
}

export function buildCanvasGenerationRequest(
  target: CanvasGenerationNode,
  sourceNodes: CanvasNode[],
  jobs: ReadonlyMap<string, Job>,
): { body: CanvasJobBody; sourceNodeIds: string[] } {
  const referenceImages: string[] = [];
  const referenceVideos: string[] = [];
  const referenceAudios: string[] = [];
  const textReferences: string[] = [];
  const usedSourceNodeIds: string[] = [];

  for (const source of sourceNodes) {
    if (source.type === 'text') {
      const text = source.data.text.trim();
      if (text) {
        textReferences.push(`参考文本「${source.data.title?.trim() || '未命名'}」：\n${text}`);
        usedSourceNodeIds.push(source.id);
      }
      continue;
    }
    if (source.type === 'resource') {
      pushMedia(source.data.media_kind, source.data.path, referenceImages, referenceVideos, referenceAudios);
      usedSourceNodeIds.push(source.id);
      continue;
    }
    const activeJob = source.data.active_job_id ? jobs.get(source.data.active_job_id) : undefined;
    if (!activeJob || activeJob.status !== 'done') continue;
    const outputIndex = source.data.selected_output_index ?? 0;
    const output = activeJob.output_paths[outputIndex];
    if (output) {
      pushMedia(source.data.media_kind, output, referenceImages, referenceVideos, referenceAudios);
      usedSourceNodeIds.push(source.id);
    }
  }

  const params: JobParams = { ...target.data.draft.params };
  if (referenceImages.length) params.reference_images = referenceImages;
  else delete params.reference_images;
  if (referenceVideos.length) params.reference_videos = referenceVideos;
  else delete params.reference_videos;
  if (referenceAudios.length) params.reference_audios = referenceAudios;
  else delete params.reference_audios;

  const basePrompt = target.data.draft.prompt.trim();
  const prompt = [basePrompt, ...textReferences].filter(Boolean).join('\n\n');
  return {
    body: {
      prompt,
      model: target.data.draft.model,
      params,
      alias: target.data.draft.alias || undefined,
      kind: target.data.media_kind,
    },
    sourceNodeIds: usedSourceNodeIds,
  };
}

function pushMedia(
  kind: 'image' | 'video' | 'audio',
  path: string,
  images: string[],
  videos: string[],
  audios: string[],
) {
  if (kind === 'image') images.push(path);
  else if (kind === 'video') videos.push(path);
  else audios.push(path);
}
