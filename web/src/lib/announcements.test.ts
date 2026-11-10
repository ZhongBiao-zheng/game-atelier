import { describe, expect, it } from 'vitest';

import { CHANGELOG } from './changelog';
import { ANNOUNCEMENTS, announcementsInSameRelease, type Announcement } from './announcements';

const announcement = (id: string, version: string): Announcement => ({
  id, date: '2026-11-10', version, title: id, summary: '', imageUrl: '', models: [],
});

describe('announcementsInSameRelease', () => {
  it('只返回同一版本发出的公告，新的在前；同一天的两个版本不混在一起', () => {
    const newer = announcement('newer', '5.135.0');
    const sameDayOlder = announcement('same-day-older', '5.134.0');
    const alsoNewer = announcement('also-newer', '5.135.0');
    const all = [newer, alsoNewer, sameDayOlder];
    expect(announcementsInSameRelease(alsoNewer, all)).toEqual([newer, alsoNewer]);
    expect(announcementsInSameRelease(sameDayOlder, all)).toEqual([sameDayOlder]);
  });

  it('每条公告的版本号都对应一条更新日志', () => {
    const versions = new Set(CHANGELOG.map(entry => entry.version));
    for (const item of ANNOUNCEMENTS) expect(versions, item.id).toContain(item.version);
  });
});
