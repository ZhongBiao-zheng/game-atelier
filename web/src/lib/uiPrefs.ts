import { requestJson } from '@/api/http';

/** 界面偏好与已读记录，存在数据目录的 `.config/ui-prefs.json`（服务端 `/api/ui-prefs`）。
 *
 * 不放 localStorage：5174 被占时服务顺延到别的端口，网页 origin 一变 localStorage 就整个换一份，
 * 公告重弹、更新日志已读丢失。键名用短横线小写（`announcements-seen`）。
 */
export type UiPrefs = Record<string, unknown>;

export const UI_PREF_KEYS = {
  announcementsSeen: 'announcements-seen',
  changelogSeen: 'changelog-seen',
} as const;

/** 读不到时返回 null：调用方据此「什么都不做」，不能把读失败当成首次使用。 */
export function loadUiPrefs(): Promise<UiPrefs | null> {
  return requestJson<{ prefs?: unknown }>('/api/ui-prefs', '读取界面偏好')
    .then(body => (body?.prefs && typeof body.prefs === 'object' && !Array.isArray(body.prefs) ? body.prefs as UiPrefs : {}))
    .catch(() => null);
}

/** 写一个键；失败只少记一次已读，不打断界面。 */
export function saveUiPref(key: string, value: unknown): Promise<void> {
  return requestJson(`/api/ui-prefs/${encodeURIComponent(key)}`, '保存界面偏好', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  }).then(() => undefined, () => undefined);
}
