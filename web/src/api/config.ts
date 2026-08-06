/** 应用级设置（`.runtime/config.json`）。POST 是合并式补丁：只更新传入的键。 */
export interface AppConfig {
  image_storage_root: string;
  show_studio_on_home: boolean;
}

export async function fetchConfig(): Promise<AppConfig> {
  const resp = await fetch('/api/config');
  if (!resp.ok) throw new Error(`config fetch failed: ${resp.status}`);
  const data = (await resp.json()) as Partial<AppConfig>;
  return {
    image_storage_root: data.image_storage_root ?? '',
    show_studio_on_home: !!data.show_studio_on_home,
  };
}

export async function updateConfig(patch: Partial<AppConfig>): Promise<void> {
  const resp = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`config update failed: ${resp.status}`);
}
