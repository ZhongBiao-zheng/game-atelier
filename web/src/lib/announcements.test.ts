import { describe, expect, it } from 'vitest';

import feed from '../../../src/character_workflow/data/announcements.json';
import { CHANGELOG } from './changelog';
import { announcementsInSameRelease, latestUnseenAnnouncement, type Announcement } from './announcements';

const announcement = (id: string, version: string, date = '2026-11-10'): Announcement => ({
  id, date, version, title: id, summary: '', imageUrl: '', models: [],
});

describe('announcementsInSameRelease', () => {
  it('同版本同一天才算一批，新的在前；同一天的两个版本不混在一起', () => {
    const newer = announcement('newer', '5.135.0');
    const sameDayOlder = announcement('same-day-older', '5.134.0');
    const alsoNewer = announcement('also-newer', '5.135.0');
    const all = [newer, alsoNewer, sameDayOlder];
    expect(announcementsInSameRelease(alsoNewer, all)).toEqual([newer, alsoNewer]);
    expect(announcementsInSameRelease(sameDayOlder, all)).toEqual([sameDayOlder]);
  });

  it('只发公告时 version 填已发布版本：不和那一版早先的公告翻在一起', () => {
    const shipped = announcement('shipped-with-release', '5.137.0', '2026-11-13');
    const later = announcement('announcement-only', '5.137.0', '2026-11-20');
    expect(announcementsInSameRelease(later, [later, shipped])).toEqual([later]);
  });
});

describe('公告数据文件', () => {
  const items = feed.announcements as Announcement[];

  it('每条公告的版本号都对应一条已发布的更新日志', () => {
    const versions = new Set(CHANGELOG.map(entry => entry.version));
    for (const item of items) expect(versions, item.id).toContain(item.version);
  });

  it('摘要两行以内：弹窗宽 448px、14px 字一行约 29 个汉字（英文数字按半个算）', () => {
    const width = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? 0.5 : 1), 0);
    for (const item of items) expect(width(item.summary), item.id).toBeLessThanOrEqual(52);
  });

  it('id 唯一，新的在前', () => {
    expect(new Set(items.map(item => item.id)).size).toBe(items.length);
    const dates = items.map(item => item.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('最新一条未读才弹，读过就不弹', () => {
    expect(latestUnseenAnnouncement(items, [])).toBe(items[0]);
    expect(latestUnseenAnnouncement(items, [items[0].id])).toBeNull();
    expect(latestUnseenAnnouncement([], [])).toBeNull();
  });
});
