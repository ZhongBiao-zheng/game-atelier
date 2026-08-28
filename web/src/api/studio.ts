import { requestJson } from './http';
import type { Job, JobKind, JobParams } from '@/schema/jobs';

export interface StudioJobCreate {
  prompt: string;
  model: string;
  params: JobParams;
  alias?: string;
  kind?: JobKind;
}

export type StudioArchiveTarget =
  | {
      kind: 'character';
      character_id: string; asset_slot: 'portrait' | 'promo' | 'turnaround';
    }
  | {
      kind: 'ui';
      ui_scheme_id: string; screen_id: string;
    }
  | {
      kind: 'video';
      production_id: string;
    };

export type StudioArchiveTargetOption = StudioArchiveTarget & {
  label: string;
  detail: string;
};

export function studioArchiveTarget(option: StudioArchiveTargetOption): StudioArchiveTarget {
  if (option.kind === 'character') {
    return {
      kind: option.kind,
      character_id: option.character_id,
      asset_slot: option.asset_slot,
    };
  }
  if (option.kind === 'ui') {
    return { kind: option.kind, ui_scheme_id: option.ui_scheme_id, screen_id: option.screen_id };
  }
  return { kind: option.kind, production_id: option.production_id };
}

export async function fetchStudioArchiveTargets(
  projectId: string,
  mediaKind: JobKind,
): Promise<StudioArchiveTargetOption[]> {
  const data = await requestJson<{ targets: StudioArchiveTargetOption[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/studio-archive-targets?media_kind=${encodeURIComponent(mediaKind)}`,
    '读取项目归档位置',
  );
  return data.targets;
}

export async function archiveStudioOutput(
  jobId: string,
  payload: { source_path: string; project_id: string; target: StudioArchiveTarget },
): Promise<{ job: Job; path: string }> {
  return requestJson<{ job: Job; path: string }>(
    `/api/studio/jobs/${encodeURIComponent(jobId)}/archive`,
    '归档创作台产物',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
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

export async function listStudioJobs(): Promise<Job[]> {
  // Canvas 是独立人工创作空间；它的运行历史只在画布节点内展示，不进入创作台时间线。
  const jobs = await requestJson<Job[]>('/api/jobs', '读取出图记录');
  return jobs.filter(job => job.namespace !== 'canvas');
}

export async function getStudioJob(jobId: string): Promise<Job | null> {
  const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!resp.ok) return null;
  const job = (await resp.json()) as Job;
  return job.namespace === 'canvas' ? null : job;
}
