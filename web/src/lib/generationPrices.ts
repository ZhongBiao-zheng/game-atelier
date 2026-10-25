/**
 * 生成费用价目表——共享价表的 TypeScript 导出，币种随各表声明。
 *
 * 调价只改 src/character_workflow/data/generation_prices.json；渠道匹配与计费公式在 generationCost.ts。
 * 型号 key 使用小写，`.` / `_` 统一为 `-`。未知型号或分组不要填推测价格。
 * 来源、单位、更新步骤见 docs/references/generation-pricing.md。
 */
import type { Quality } from '@/lib/imageControlCaps';
import prices from '@pricing';

// OpenAI-HK：元 / 张；来源见调价文档。
export const OPENAI_HK_FIXED_YUAN_PER_IMAGE: Record<string, number> = prices.OPENAI_HK_FIXED_YUAN_PER_IMAGE;
export const OPENAI_HK_NANO_BANANA_2_YUAN: Partial<Record<Quality, number>> = prices.OPENAI_HK_NANO_BANANA_2_YUAN;

// EvoLink MJ V8.2：美元 / 请求，2026-10-15 官方模型页核实；每次最多四张，不按 n 倍乘。
// 人民币展示使用共享价表的估算汇率。
export const EVOLINK_MIDJOURNEY_USD_PER_REQUEST = prices.EVOLINK_MIDJOURNEY_USD_PER_REQUEST;
export const GENERATION_USD_TO_CNY = prices.GENERATION_USD_TO_CNY;

// 火山 Ark 直连：元 / 张。
export const ARK_SEEDREAM_YUAN_PER_IMAGE: Record<string, number> = prices.ARK_SEEDREAM_YUAN_PER_IMAGE;

// 火山 Ark 直连 Seedance：元 / 百万输出 token。
export const ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS = prices.ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS;

// 阿里 DashScope 直连 HappyHorse：元 / 秒；t2v / i2v / r2v 同价。
export const HAPPYHORSE_1_1_YUAN_PER_SECOND: Record<string, number> = prices.HAPPYHORSE_1_1_YUAN_PER_SECOND;
export const HAPPYHORSE_1_0_YUAN_PER_SECOND: Record<string, number> = prices.HAPPYHORSE_1_0_YUAN_PER_SECOND;
