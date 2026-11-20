import { describe, expect, it } from 'vitest';
import type { CanvasAgentSessionUsage } from '@/schema/canvas';
import { agentUsageLabel, formatTokens } from './canvasAgentUsage';

const usage = (patch: Partial<CanvasAgentSessionUsage>): CanvasAgentSessionUsage => ({
  requests: 3, input_tokens: 12_000, output_tokens: 400, cost_cny: 0.36, unpriced: 0, source: 'local', ...patch,
});

describe('agentUsageLabel', () => {
  it('hides until the session has called the model', () => {
    expect(agentUsageLabel(null)).toBeNull();
    expect(agentUsageLabel(usage({ requests: 0 }))).toBeNull();
  });

  it('shows tokens and money', () => {
    expect(agentUsageLabel(usage({}))).toEqual({ text: '1.2万 token · 0.36¥', detail: '输入 1.2万 · 输出 400' });
  });

  it('marks unpriced, partly unpriced and host-settled sessions', () => {
    expect(agentUsageLabel(usage({ cost_cny: null, unpriced: 3 }))?.text).toBe('1.2万 token · 未计价');
    expect(agentUsageLabel(usage({ unpriced: 1 }))?.detail).toBe('输入 1.2万 · 输出 400 · 1 次未计价');
    expect(agentUsageLabel(usage({ source: 'lan', cost_cny: null, unpriced: 3 }))).toEqual({
      text: '1.2万 token · 主机结算', detail: '输入 1.2万 · 输出 400',
    });
  });

  it('shows the host-settled amount once it has been fetched', () => {
    expect(agentUsageLabel(usage({ source: 'lan', cost_cny: 0.02, unpriced: 3 }))).toEqual({
      text: '1.2万 token · 0.02¥', detail: '输入 1.2万 · 输出 400',
    });
  });

  it('formats token counts', () => {
    expect(formatTokens(9_999)).toBe('9999');
    expect(formatTokens(247_000)).toBe('24.7万');
  });
});
