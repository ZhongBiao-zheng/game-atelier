// web/src/api/experience.ts
export interface ProjectExperience {
  project: { id: string; slug: string; name: string; created_at: string; character_count: number };
  worldview_md: string;
}

export async function fetchExperience(projectId: string): Promise<ProjectExperience> {
  const resp = await fetch(`/api/experience?project=${encodeURIComponent(projectId)}`);
  if (!resp.ok) throw new Error(`experience fetch failed: ${resp.status}`);
  return (await resp.json()) as ProjectExperience;
}

export async function saveExperience(projectId: string, worldviewMd: string): Promise<void> {
  const resp = await fetch('/api/experience', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectId, worldview_md: worldviewMd }),
  });
  if (!resp.ok) throw new Error(`experience save failed: ${resp.status}`);
}
