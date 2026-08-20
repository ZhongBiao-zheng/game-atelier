import { requestJson } from './http';

export interface ProjectVideoShot {
  shot_id: string;
  purpose: string;
  duration: string;
  status: string;
  versions: string[];
  selected: string | null;
  prompt: string;
  model: string;
  reference_images: string[];
  reference_videos: string[];
  reference_audios: string[];
}

export interface ProjectVideoProduction {
  production_id: string;
  title: string;
  type: string;
  status: string;
  brief: {
    goal: string;
    platform: string;
    ratio: string;
    duration: string;
    sound: string;
  };
  shots: ProjectVideoShot[];
  exports: string[];
}

export async function fetchProjectVideos(projectId: string): Promise<ProjectVideoProduction[]> {
  const data = await requestJson<{ productions?: unknown }>(
    `/api/projects/${encodeURIComponent(projectId)}/videos`,
    '读取项目视频',
  );
  return Array.isArray(data.productions) ? data.productions as ProjectVideoProduction[] : [];
}

export async function setProjectVideoSelected(
  projectId: string,
  productionId: string,
  shotId: string,
  path: string | null,
): Promise<Record<string, string>> {
  const data = await requestJson<{ shots: Record<string, string> }>(
    `/api/projects/${encodeURIComponent(projectId)}/videos/${encodeURIComponent(productionId)}/shots/${encodeURIComponent(shotId)}/selected`,
    path ? '选定镜头版本' : '取消镜头选定',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    },
  );
  return data.shots;
}
