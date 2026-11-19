import { formatGenerationCost } from '@/lib/generationCost';
import type { CanvasAgentSessionUsage } from '@/schema/canvas';

export function formatTokens(count: number): string {
  return count >= 10_000 ? `${(count / 10_000).toFixed(1)}万` : String(count);
}

/** 面板头部的会话花费：token 合计 + 金额；经局域网网关的由主机结算，本机没有金额。没有请求时不显示。 */
export function agentUsageLabel(usage: CanvasAgentSessionUsage | null): { text: string; detail: string } | null {
  if (!usage || usage.requests === 0) return null;
  const tokens = `${formatTokens(usage.input_tokens + usage.output_tokens)} token`;
  const money = usage.source === 'lan' ? '主机结算'
    : usage.cost_cny === null ? '未计价' : formatGenerationCost(usage.cost_cny);
  const unpriced = usage.source !== 'lan' && usage.cost_cny !== null && usage.unpriced > 0
    ? ` · ${usage.unpriced} 次未计价` : '';
  return {
    text: `${tokens} · ${money}`,
    detail: `输入 ${formatTokens(usage.input_tokens)} · 输出 ${formatTokens(usage.output_tokens)}${unpriced}`,
  };
}
