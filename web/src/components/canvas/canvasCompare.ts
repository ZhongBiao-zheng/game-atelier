import type { CanvasContentVersion, CanvasNormalizedFrame } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';

export interface CanvasCompareSource {
  beforeVersionId: string;
  beforeFrame: CanvasNormalizedFrame | null;
}

interface ImageEditParams {
  source_version_id?: string; mode?: string;
  width?: number; height?: number; x?: number; y?: number;
  source_width?: number; source_height?: number;
}

/** 局部修改 / 扩图 / AI高清 的结果 → 它的原图（扩图另带原图在结果画面里的位置）。
 *  其他来源的图没有「原图」可比，返回 null。 */
export function canvasCompareSource(
  version: CanvasContentVersion | undefined,
  jobs: readonly Job[] | undefined,
  resolveVersion: (versionId: string) => CanvasContentVersion | undefined,
): CanvasCompareSource | null {
  if (version?.kind !== 'image' || version.origin.kind !== 'job_output') return null;
  const jobId = version.origin.job_id;
  const snapshot = jobs?.find(job => job.job_id === jobId)?.canvas_run?.snapshot;
  if (!snapshot) return null;
  const params = snapshot.normalized_params;
  const edit = params.image_edit as ImageEditParams | undefined;
  let beforeVersionId: string | undefined;
  let beforeFrame: CanvasNormalizedFrame | null = null;
  if (edit?.source_version_id) {
    beforeVersionId = edit.source_version_id;
    if (edit.mode === 'outpaint' && edit.width && edit.height && edit.source_width && edit.source_height) {
      beforeFrame = {
        x: (edit.x ?? 0) / edit.width, y: (edit.y ?? 0) / edit.height,
        width: edit.source_width / edit.width, height: edit.source_height / edit.height,
      };
    }
  } else if (typeof params.upscale_target === 'string') {
    beforeVersionId = snapshot.inputs.find(input => input.kind === 'image')?.version_id;
  }
  if (!beforeVersionId || beforeVersionId === version.version_id) return null;
  return resolveVersion(beforeVersionId)?.kind === 'image' ? { beforeVersionId, beforeFrame } : null;
}
