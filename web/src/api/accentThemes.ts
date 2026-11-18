import { requestJson } from './http';
import type { AccentThemes, AccentThemesBody } from '@/schema/accentThemes';

export function getAccentThemes(): Promise<AccentThemes> {
  return requestJson<AccentThemes>('/api/accent-themes', '读取主题色');
}

export function saveAccentThemes(expectedRevision: number, body: AccentThemesBody): Promise<AccentThemes> {
  return requestJson<AccentThemes>('/api/accent-themes', '保存主题色', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, active: body.active, overrides: body.overrides, custom: body.custom }),
  });
}
