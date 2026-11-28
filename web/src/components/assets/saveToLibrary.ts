import { libraryWrite, uploadItem } from '@/api/library';
import { request } from '@/api/http';
import { renderCreationPrompt } from '@/schema/creationAssets';
import type { CreationAssetSaveRequest } from './creationAssetPanelModel';

export async function saveToLibrary(folder: string, input: CreationAssetSaveRequest) {
  if (input.kind === 'prompt') {
    const file = new File([renderCreationPrompt(input.segments)], (input.title || '提示词') + '.md', { type: 'text/markdown' });
    return uploadItem(folder, file);
  }
  if (input.source?.kind === 'job_output') {
    return libraryWrite(folder + '/history', { job_id: input.source.job_id, output_index: input.source.output_index });
  }
  if (input.source?.kind === 'canvas_result') {
    return libraryWrite(folder + '/canvas', { project_id: input.source.canvas_project_id, version_id: input.source.version_id });
  }
  if (input.file) return uploadItem(folder, input.file);
  if (!input.previewUrl) throw new Error('找不到素材来源');
  const blob = await (await request(input.previewUrl, '读取素材')).blob();
  const file = new File([blob], input.sourcePath?.split('/').pop() || input.title || '素材', { type: blob.type });
  return uploadItem(folder, file);
}
