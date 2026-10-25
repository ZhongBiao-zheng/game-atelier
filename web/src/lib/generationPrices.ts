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

// Tuzi default 香蕉 Pro：元 / 次（一张）。用户提供的 2026-10-12 降价公告，并与公开 /api/pricing
// 核对，来源与换算规则见调价文档。
// gemini-3-pro-image 与 gemini-3-pro-image-preview 为同一模型，共用此表。
// nano-banana-pro 与其固定 2K/4K 展示别名也共用，不复制单价。
export const TUZI_GEMINI_3_PRO_YUAN_PER_IMAGE = prices.TUZI_GEMINI_3_PRO_YUAN_PER_IMAGE;

// Tuzi default GPT Image 2：元 / 张。2026-09-04 用户公告及公开 /api/pricing 核对。
// 最终 size 精确命中白名单时算 1K，其余按总像素分档；不是最长边。
export const TUZI_GPT_IMAGE_2_YUAN_PER_IMAGE = prices.TUZI_GPT_IMAGE_2_YUAN_PER_IMAGE;
export const TUZI_GPT_IMAGE_2_PIXEL_LIMITS = prices.TUZI_GPT_IMAGE_2_PIXEL_LIMITS;
export const TUZI_GPT_IMAGE_2_1K_SIZES: ReadonlySet<string> = new Set(prices.TUZI_GPT_IMAGE_2_1K_SIZES);
// 独立固定价型号，不因用户传入的 size / quality 改价；厂商负责匹配最近比例。
export const TUZI_GPT_IMAGE_2_1K_YUAN_PER_IMAGE = prices.TUZI_GPT_IMAGE_2_1K_YUAN_PER_IMAGE;

// Tuzi default，2026-10-21 /api/pricing 分组表达式及 /api/status 人民币系数。
// 显式 quality=1k/2k/4k 优先于像素；未指定档位时按最终 size 判定。
export const TUZI_GPT_IMAGE_25_YUAN_PER_IMAGE: Record<string, Record<'1K' | '2K' | '4K', number>> = prices.TUZI_GPT_IMAGE_25_YUAN_PER_IMAGE;
export const TUZI_GPT_IMAGE_25_PIXEL_LIMITS = prices.TUZI_GPT_IMAGE_25_PIXEL_LIMITS;
export const TUZI_GPT_IMAGE_25_1K_YUAN_PER_IMAGE = prices.TUZI_GPT_IMAGE_25_1K_YUAN_PER_IMAGE;

// Tuzi：元 / 张；其他模型与分组沿用已有核价。
export const TUZI_GROUP_YUAN_PER_IMAGE: Record<string, Record<string, number>> = prices.TUZI_GROUP_YUAN_PER_IMAGE;
// 元 / 任务：一次 imagine 拆出四张图仍只计一次。
export const TUZI_MIDJOURNEY_YUAN_PER_TASK = prices.TUZI_MIDJOURNEY_YUAN_PER_TASK;

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
