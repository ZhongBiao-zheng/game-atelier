import { request, requestJson } from './http';
/** 应用级设置（`.runtime/config.json`）。POST 是合并式补丁：只更新传入的键。 */
export interface AppConfig {
  image_storage_root: string;
  show_studio_on_home: boolean;
}

export async function fetchConfig(): Promise<AppConfig> {
  const data = await requestJson<Partial<AppConfig>>('/api/config', '读取应用设置');
  return {
    image_storage_root: data.image_storage_root ?? '',
    show_studio_on_home: !!data.show_studio_on_home,
  };
}

export async function updateConfig(patch: Partial<AppConfig>): Promise<void> {
  await request('/api/config', '保存应用设置', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
