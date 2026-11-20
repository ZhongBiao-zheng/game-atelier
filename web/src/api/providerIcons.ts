import { requestJson } from './http';

/** 上传供应商图标（I1）：服务端校验、重新编码后只返回引用，由表单保存时写进 KEY 的 `icon`。 */
export function uploadProviderIcon(file: File): Promise<{ icon: string }> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<{ icon: string }>('/api/provider-icons', '上传图标', { method: 'POST', body: form });
}

/** 按网址取站点图标：服务端只连公网地址，取到后同样只返回引用。 */
export function fetchProviderIcon(url: string): Promise<{ icon: string }> {
  return requestJson<{ icon: string }>('/api/provider-icons/fetch', '获取图标', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
}

/** 按网址获取的默认地址：官网，没有时取接口地址的 origin。 */
export function defaultIconUrl(homepage: string | null | undefined, baseUrl: string | null | undefined): string {
  if (homepage?.trim()) return homepage.trim();
  try {
    return baseUrl?.trim() ? new URL(baseUrl.trim()).origin : '';
  } catch {
    return '';
  }
}

/** `file:<sha256>` → 读取地址；不是这种形式返回 null。 */
export function providerIconUrl(icon: string | null | undefined): string | null {
  const sha = icon?.startsWith('file:') ? icon.slice(5) : null;
  return sha && /^[0-9a-f]{64}$/.test(sha) ? `/api/provider-icons/${sha}` : null;
}
