import { describe, expect, it } from 'vitest';
import { formatBeijingTime } from './time';

describe('formatBeijingTime', () => {
  it('UTC → 北京时间 +8', () => {
    expect(formatBeijingTime('2026-05-29T00:00:00Z')).toBe('2026-05-29 08:00');
  });
  it('非法输入回退原串', () => {
    expect(formatBeijingTime('not-a-date')).toBe('not-a-date');
  });
});
