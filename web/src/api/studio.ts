import type { Job, JobKind, JobParams } from '@/schema/jobs';

export interface StudioJobCreate {
  prompt: string;
  model: string;
  params: JobParams;
  alias?: string;
  kind?: JobKind;
}

export async function createStudioJob(body: StudioJobCreate): Promise<Job> {
  const resp = await fetch('/api/studio/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`studio job failed: ${resp.status}`);
  return resp.json();
}

/** 上传一张参考图到 .runtime/uploads/，返回服务器绝对路径（写入 job.params.reference_images 用）。 */
export async function uploadReferenceImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const resp = await fetch('/api/uploads', { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
  const data = (await resp.json()) as { path: string };
  return data.path;
}

export async function listStudioJobs(): Promise<Job[]> {
  const resp = await fetch('/api/jobs');
  if (!resp.ok) throw new Error(`studio jobs failed: ${resp.status}`);
  // 记录统一：Studio 历史现展示全部出图（studio + skill 角色出图），按 status 过滤在前端 filterRounds 里做。
  return (await resp.json()) as Job[];
}

export async function getStudioJob(jobId: string): Promise<Job | null> {
  const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!resp.ok) return null;
  // 不再按 namespace 过滤：skill 角色出图的 SSE 更新也要进 Studio 历史（pending_confirm 在 round 派生时排除）。
  return (await resp.json()) as Job;
}
