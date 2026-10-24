import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UsageResponse } from '@/schema/usage';
import { TrendChart } from './TrendChart';

const day = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

describe('花费趋势', () => {
  it('今天没有花费时仍用主色标出当前这一天', () => {
    const data = { bucket: 'day', trend: [{ start: day(-1), cost_cny: 3 }, { start: day(0), cost_cny: 0 }] } as UsageResponse;
    render(<TrendChart data={data} />);
    const [yesterday, today] = screen.getAllByRole('img');
    expect(today.className).toContain('bg-primary');
    expect(yesterday.className).toContain('trend-history');
  });
});
