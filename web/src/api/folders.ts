import { requestJson } from './http';
export async function chooseFolder(title: string, initialPath?: string): Promise<string | null> {
  const data = await requestJson<{ path?: string | null }>('/api/folder-picker', '打开文件夹选择器', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, initial_path: initialPath || null }),
  });
  return data.path ?? null;
}
