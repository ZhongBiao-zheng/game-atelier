import { requestJson } from './http';
import type { Job, JobKind, JobParams } from '@/schema/jobs';

export interface StudioJobCreate {
  prompt: string;
  model: string;
  params: JobParams;
  alias?: string;
  kind?: JobKind;
}

export async function createStudioJob(body: StudioJobCreate): Promise<Job> {
  return requestJson<Job>('/api/studio/jobs', '创建出图任务', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 上传一张参考图到 .runtime/uploads/，返回服务器绝对路径（写入 job.params.reference_images 用）。
 *
 * 失败报错的自证信息（哪个文件 / 多大 / 多少像素 / 上限多少）由服务端 detail 给 ——
 * 限额与判据都在 routes.py，前端复述一份必然漂移。这里只补「是上传参考图这一步」。 */
export async function uploadReferenceImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const data = await requestJson<{ path: string }>('/api/uploads', '上传参考图', {
    method: 'POST',
    body: form,
  });
  return data.path;
}

export interface MjReferenceFiles {
  image: File[];
  sref: File[];
  cref: File[];
  oref: File[];
}

export interface MjReferencePaths {
  sref?: string[];
  cref?: string[];
  oref?: string[];
}

/** 完整版与紧凑版共用的 MJ 四组上传规则，避免任一入口漏传某个语义槽。 */
export async function resolveImageReferencePaths({
  midjourney, referenceImages, mjRefs, overrideReferenceImages, overrideMjRefPaths,
}: {
  midjourney: boolean;
  referenceImages: File[];
  mjRefs: MjReferenceFiles;
  overrideReferenceImages?: string[];
  overrideMjRefPaths?: MjReferencePaths;
}): Promise<{ referenceImages: string[]; mjRefPaths: MjReferencePaths }> {
  const paths = overrideReferenceImages
    ?? await Promise.all((midjourney ? mjRefs.image : referenceImages).map(uploadReferenceImage));
  let mjRefPaths: MjReferencePaths = {};
  if (midjourney) {
    mjRefPaths = overrideMjRefPaths ?? Object.fromEntries(
      await Promise.all(
        (['sref', 'cref', 'oref'] as const)
          .filter((slot) => mjRefs[slot].length > 0)
          .map(async (slot) => [slot, await Promise.all(mjRefs[slot].map(uploadReferenceImage))] as const),
      ),
    );
  }
  return { referenceImages: paths, mjRefPaths };
}

export async function listStudioJobs(): Promise<Job[]> {
  // 记录统一：Studio 历史现展示全部出图（studio + skill 角色出图），按 status 过滤在前端 filterRounds 里做。
  return requestJson<Job[]>('/api/jobs', '读取出图记录');
}

export async function getStudioJob(jobId: string): Promise<Job | null> {
  const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!resp.ok) return null;
  // 不再按 namespace 过滤：skill 角色出图的 SSE 更新也要进 Studio 历史（pending_confirm 在 round 派生时排除）。
  return (await resp.json()) as Job;
}
