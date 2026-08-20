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
