import { describe, expect, it } from 'vitest';
import { formatModelDuration, formatModelPrice } from './modelMetricFormat';

describe('model metric labels', () => {
  it.each([[12, '20s'], [65, '70s'], [150, '150s'], [0, '0s']])('rounds %s seconds upwards', (value, label) => {
    expect(formatModelDuration(value as number)).toBe(label);
  });
  it.each([[0.30, '0.3¥'], [0.12, '0.12¥'], [2, '2¥'], [0.126, '0.13¥'], [0, '0¥']])('formats price %s', (value, label) => {
    expect(formatModelPrice(value as number)).toBe(label);
  });
});
