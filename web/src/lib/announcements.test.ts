import { describe, expect, it } from 'vitest';

import { announcementsInSameRelease, type Announcement } from './announcements';

const announcement = (id: string, date: string): Announcement => ({
  id, date, title: id, summary: '', imageUrl: '', models: [],
});

describe('announcementsInSameRelease', () => {
  const upcoming = announcement('upcoming', '2026-11-05');
  const late = announcement('late', '2026-10-30');
  const early = announcement('early', '2026-10-28');
  const previous = announcement('previous', '2026-10-20');
  const all = [upcoming, late, early, previous];
  const releaseDates = ['2026-10-31', '2026-10-31', '2026-10-27'];

  it('只返回同一次发版内的公告，新的在前', () => {
    expect(announcementsInSameRelease(early, all, releaseDates)).toEqual([late, early]);
    expect(announcementsInSameRelease(previous, all, releaseDates)).toEqual([previous]);
  });

  it('比最新版本还新的公告归到下一次发版', () => {
    expect(announcementsInSameRelease(upcoming, all, releaseDates)).toEqual([upcoming]);
  });
});
