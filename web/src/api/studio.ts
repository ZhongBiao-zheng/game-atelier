import { connectionFetch } from '@/api/connection';
import { ApiError, apiError, requestError, requestJson } from './http';
import type { Job, JobKind, JobParams } from '@/schema/jobs';

export interface StudioJobCreate {
  prompt: string;
  prompt_template?: string;
  model: string;
  params: JobParams;
  alias?: string;
  kind?: JobKind;
  studio_agent_session_id?: string;
  /** 「再次生成」来自的失败轮次：网关未确认的失败、请求不变时由服务端接回原任务。 */
  reattach_job_id?: string;
  /** 一次提交意图一个（`newStudioRequestId`），重试沿用：服务端同 ID 只建一个任务。 */
  client_request_id?: string;
}

/** 客户端请求 ID：`<UTC YYYYmmddHHMMSS><8 位十六进制>`，与服务端任务 ID 同形。 */
export function newStudioRequestId(): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return stamp + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

/** 服务端明确拒绝（4xx）：任务没建。连不上、5xx、回包读不出都算受理未知，要先按请求 ID 核对。 */
export function submissionRejected(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** 受理未知时核对：这个请求 ID 建过任务就返回它，没建过返回 null；连不上照常抛错。 */
export async function findStudioJobByRequest(requestId: string): Promise<Job | null> {
  let resp: Response;
  try {
    resp = await connectionFetch(`/api/studio/jobs/by-request/${encodeURIComponent(requestId)}`);
  } catch (error) {
    throw requestError(error, '核对提交结果');
  }
  if (resp.status === 404) return null;
  if (!resp.ok) throw await apiError(resp, '核对提交结果');
  return (await resp.json()) as Job;
}

/** 失败卡「重新查询」：凭上游任务号续查，不重新下单。 */
export async function requeryStudioJob(jobId: string): Promise<Job> {
  return requestJson<Job>(`/api/studio/jobs/${encodeURIComponent(jobId)}/requery`, '重新查询', { method: 'POST' });
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
  srefCodeActive = false,
}: {
  midjourney: boolean;
  referenceImages: File[];
  mjRefs: MjReferenceFiles;
  overrideReferenceImages?: string[];
  overrideMjRefPaths?: MjReferencePaths;
  /** 编号式 sref 生效时，图片式 sref 不上传、不复用、不写入 job。 */
  srefCodeActive?: boolean;
}): Promise<{ referenceImages: string[]; mjRefPaths: MjReferencePaths }> {
  const paths = overrideReferenceImages
    ?? await Promise.all((midjourney ? mjRefs.image : referenceImages).map(uploadReferenceImage));
  let mjRefPaths: MjReferencePaths = {};
  if (midjourney) {
    const reusable = overrideMjRefPaths
      ? Object.fromEntries(Object.entries(overrideMjRefPaths)
          .filter(([slot]) => slot !== 'sref' || !srefCodeActive))
      : undefined;
    mjRefPaths = reusable ?? Object.fromEntries(
      await Promise.all(
        (['sref', 'cref', 'oref'] as const)
          .filter((slot) => (slot !== 'sref' || !srefCodeActive) && mjRefs[slot].length > 0)
          .map(async (slot) => [slot, await Promise.all(mjRefs[slot].map(uploadReferenceImage))] as const),
      ),
    );
  }
  return { referenceImages: paths, mjRefPaths };
}

/** 「删除这一轮」（给 path 时只删这一张）：移进回收站，返回 trash_id（撤销时 restoreTrash）。 */
export async function deleteStudioRound(jobId: string, path?: string): Promise<string> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const body = await requestJson<{ trash_id: string }>(
    `/api/studio/jobs/${encodeURIComponent(jobId)}${query}`, '删除', { method: 'DELETE' },
  );
  return body.trash_id;
}

/** 结果卡「加入画布」：在目标画布新建图片 / 视频节点。 */
export async function addStudioResultToCanvas(jobId: string, outputIndex: number, projectId: string): Promise<void> {
  await requestJson(`/api/studio/jobs/${encodeURIComponent(jobId)}/canvas`, '加入画布', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, output_index: outputIndex }),
  });
}

export async function getStudioJob(jobId: string): Promise<Job | null> {
  const resp = await connectionFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!resp.ok) return null;
  const job = (await resp.json()) as Job;
  return job.namespace === 'studio' ? job : null;
}
