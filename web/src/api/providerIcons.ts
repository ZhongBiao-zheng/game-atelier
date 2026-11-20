import { requestJson } from './http';

/** 上传供应商图标（I1）：服务端校验、重新编码后只返回引用，由表单保存时写进 KEY 的 `icon`。 */
export function uploadProviderIcon(file: File): Promise<{ icon: string }> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<{ icon: string }>('/api/provider-icons', '上传图标', { method: 'POST', body: form });
}

/** `file:<sha256>` → 读取地址；不是这种形式返回 null。 */
export function providerIconUrl(icon: string | null | undefined): string | null {
  const sha = icon?.startsWith('file:') ? icon.slice(5) : null;
  return sha && /^[0-9a-f]{64}$/.test(sha) ? `/api/provider-icons/${sha}` : null;
}
