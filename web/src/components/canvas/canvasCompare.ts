import type { CanvasCompareSlot, CanvasContentVersion, CanvasNormalizedFrame } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';

/** 对比节点一侧当前接入的图：来源节点与它此刻显示的版本。 */
export interface CanvasCompareSide {
  nodeId: string;
  title: string;
  versionId: string | null;
}

export type CanvasCompareInputs = Partial<Record<CanvasCompareSlot, CanvasCompareSide>>;

export interface CanvasCompareSource {
  beforeVersionId: string;
  /** 生成快照里登记的原图节点；节点可能已被删除或换了图，使用前要再核对。 */
  beforeNodeId: string | null;
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
  if (resolveVersion(beforeVersionId)?.kind !== 'image') return null;
  const beforeNodeId = snapshot.inputs.find(input => input.version_id === beforeVersionId)?.node_id ?? null;
  return { beforeVersionId, beforeNodeId, beforeFrame };
}

/** 扩图结果对比它自己的原图时，原图要放回扩图时的位置；其他组合两张图各自完整放进画框。 */
export function canvasCompareFrame(
  beforeVersionId: string | null | undefined,
  afterVersion: CanvasContentVersion | undefined,
  jobs: readonly Job[] | undefined,
  resolveVersion: (versionId: string) => CanvasContentVersion | undefined,
): CanvasNormalizedFrame | null {
  if (!beforeVersionId) return null;
  const source = canvasCompareSource(afterVersion, jobs, resolveVersion);
  return source?.beforeVersionId === beforeVersionId ? source.beforeFrame : null;
}
