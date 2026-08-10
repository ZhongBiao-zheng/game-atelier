import type { AssetSlot, CanonicalFile, ScreenCanonicalFile } from '@/schema/jobs';

/** 角色定稿表（A2）。canonical.json 缺失时后端返回全 null。 */
export async function fetchCanonical(characterId: string): Promise<CanonicalFile> {
  const resp = await fetch(`/api/characters/${encodeURIComponent(characterId)}/canonical`);
  if (!resp.ok) throw new Error(`canonical fetch failed: ${resp.status}`);
  return (await resp.json()) as CanonicalFile;
}

/** path=null 取消该 slot 定稿；每 slot 至多一张，设新图自动顶掉旧定稿。 */
export async function setCanonical(
  characterId: string,
  slot: AssetSlot,
  path: string | null,
): Promise<CanonicalFile> {
  const resp = await fetch(`/api/characters/${encodeURIComponent(characterId)}/canonical`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot, path }),
  });
  if (!resp.ok) throw new Error(`canonical update failed: ${resp.status}`);
  return (await resp.json()) as CanonicalFile;
}

/** 项目 screen 定稿表（B3）。canonical.json 缺失时后端返回 {screens: {}}。 */
export async function fetchScreenCanonical(projectId: string): Promise<ScreenCanonicalFile> {
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/screens/canonical`);
  if (!resp.ok) throw new Error(`screen canonical fetch failed: ${resp.status}`);
  return (await resp.json()) as ScreenCanonicalFile;
}

/** path=null 取消该 screen 定稿；风格标签由后端从 job 反查，不用前端报。 */
export async function setScreenCanonical(
  projectId: string,
  screenId: string,
  path: string | null,
): Promise<ScreenCanonicalFile> {
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/screens/canonical`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen_id: screenId, path }),
  });
  if (!resp.ok) throw new Error(`screen canonical update failed: ${resp.status}`);
  return (await resp.json()) as ScreenCanonicalFile;
}

/** canonical 存 data-root 相对路径、job.output_paths 是绝对路径——后缀比对两态通吃。 */
export function isCanonicalPath(path: string, entry: { path: string } | null | undefined): boolean {
  if (!entry) return false;
  return path === entry.path || path.endsWith(`/${entry.path}`);
}
