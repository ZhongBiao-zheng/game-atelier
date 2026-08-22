import { requestJson } from './http';
import type { AssetSlot, CanonicalFile, ScreenCanonicalFile } from '@/schema/jobs';

/** 角色定稿表（A2）。canonical.json 缺失时后端返回全 null。 */
export async function fetchCanonical(characterId: string): Promise<CanonicalFile> {
  return requestJson<CanonicalFile>(
    `/api/characters/${encodeURIComponent(characterId)}/canonical`,
    '读取角色定稿表',
  );
}

/** path=null 取消该 slot 定稿；每 slot 至多一张，设新图自动顶掉旧定稿。 */
export async function setCanonical(
  characterId: string,
  slot: AssetSlot,
  path: string | null,
): Promise<CanonicalFile> {
  return requestJson<CanonicalFile>(
    `/api/characters/${encodeURIComponent(characterId)}/canonical`,
    path === null ? '取消定稿' : '设为定稿',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, path }),
    },
  );
}

/** 项目 screen 定稿表（B3）。canonical.json 缺失时后端返回 {screens: {}}。 */
export async function fetchScreenCanonical(
  projectId: string,
  schemeId: string,
): Promise<ScreenCanonicalFile> {
  return requestJson<ScreenCanonicalFile>(
    `/api/projects/${encodeURIComponent(projectId)}/ui-schemes/${encodeURIComponent(schemeId)}/screens/canonical`,
    '读取页面定稿表',
  );
}

/** path=null 取消该 screen 定稿；风格标签由后端从 job 反查，不用前端报。 */
export async function setScreenCanonical(
  projectId: string,
  schemeId: string,
  screenId: string,
  path: string | null,
): Promise<ScreenCanonicalFile> {
  return requestJson<ScreenCanonicalFile>(
    `/api/projects/${encodeURIComponent(projectId)}/ui-schemes/${encodeURIComponent(schemeId)}/screens/canonical`,
    path === null ? '取消页面定稿' : '设为页面定稿',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen_id: screenId, path }),
    },
  );
}

/** canonical 存 data-root 相对路径、job.output_paths 是绝对路径——后缀比对两态通吃。 */
export function isCanonicalPath(path: string, entry: { path: string } | null | undefined): boolean {
  if (!entry) return false;
  return path === entry.path || path.endsWith(`/${entry.path}`);
}
