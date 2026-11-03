import type { CanvasContentVersion } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { PromptPreviewRequest } from '@/components/assets/SetPromptPreviewDialog';

/** 结果版本可能不是 Job 的第一个产物；用登记路径定位，不能用候选数组下标猜。 */
export function canvasPromptPreviewSource(version: CanvasContentVersion | undefined, jobs: readonly Job[]): PromptPreviewRequest | null {
  if (version?.kind !== 'image' || (version.origin.kind !== 'job_output' && version.origin.kind !== 'layer_decomposition')) return null;
  const jobId = version.origin.job_id;
  const job = jobs.find(item => item.job_id === jobId);
  if (!job) return null;
  const relative = version.path.replaceAll('\\', '/');
  const index = job.output_paths.findIndex(path => {
    const normalized = path.replaceAll('\\', '/');
    return normalized === relative || normalized.endsWith(`/${relative}`);
  });
  return index < 0 ? null : { jobId, outputIndex: index, promptAssetId: job.params?.prompt_asset_id };
}
