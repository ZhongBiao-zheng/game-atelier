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
  const jobs = await resp.json() as Job[];
  return jobs.filter((job) => job.namespace === 'studio');
}

export async function getStudioJob(jobId: string): Promise<Job | null> {
  const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!resp.ok) return null;
  const job = await resp.json() as Job;
  return job.namespace === 'studio' ? job : null;
}
