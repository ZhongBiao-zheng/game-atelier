import type { Quality } from '@/lib/imageControlCaps';

/** OpenAI-HK 聚合商价目（积分），按模型 id × 质量档位计。
 * 10000 积分 = 1 元——按飙哥给的样例校准（GPT2 低质量 600 积分 = 0.06¥）。
 * 没测过价的模型/档位不入表 → 前端不显示消耗提示；后续价目直接补表。
 * 额度余量没有查询通道（keys.json 只存 API key，无 billing 端点）。
 */
const CREDITS_PER_YUAN = 10000;

const HK_CREDIT_TABLE: Record<string, Partial<Record<Quality, number>>> = {
  'gpt-image-2': { low: 600, medium: 1200, high: 2400 },
  'nano-banana': { low: 2000 },
  'nano-banana-2': { low: 4800, medium: 9600 },
  'nano-banana-hd': { low: 3200 },
};

/** 消耗提示只对 OpenAI-HK 聚合商显示，其余厂商没有价目。 */
export function isHkAggregator(baseUrl?: string | null): boolean {
  return Boolean(baseUrl?.includes('openai-hk'));
}

/** 单次提交的预计消耗（元）；价目未知返回 null（调用方隐藏提示）。 */
export function estimateCostYuan({
  model,
  quality,
  n = 1,
}: {
  model?: string;
  quality?: Quality;
  n?: number;
}): number | null {
  const credits = model && quality ? HK_CREDIT_TABLE[model]?.[quality] : undefined;
  if (credits == null) return null;
  return (credits * Math.max(1, n)) / CREDITS_PER_YUAN;
}
