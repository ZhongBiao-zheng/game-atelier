/**
 * 生成费用价目表（人民币）——所有本地估价单价的唯一维护入口。
 *
 * 调价只改此文件的数字；渠道匹配与计费公式在 generationCost.ts。
 * 型号 key 使用小写，`.` / `_` 统一为 `-`。未知型号或分组不要填推测价格。
 * 来源、单位、更新步骤见 docs/references/generation-pricing.md。
 */
import type { Quality } from '@/lib/imageControlCaps';

// OpenAI-HK：元 / 张；沿用已核实价格，本轮未调价。
export const OPENAI_HK_FIXED_YUAN_PER_IMAGE: Record<string, number> = {
  'gpt-image-2': 0.08,
  'nano-banana': 0.2,
  'nano-banana-hd': 0.32,
};
export const OPENAI_HK_NANO_BANANA_2_YUAN: Partial<Record<Quality, number>> = {
  low: 0.48,
  medium: 0.72,
  high: 1,
};

// Tuzi default 香蕉 Pro：元 / 次（一张）。用户提供的 2026-08-31 调价公告。
// gemini-3-pro-image 与 gemini-3-pro-image-preview 为同一模型，共用此表。
// nano-banana-pro 与其固定 2K/4K 展示别名也共用，不复制单价。
export const TUZI_GEMINI_3_PRO_YUAN_PER_IMAGE = {
  '1k': 0.12,
  '2k': 0.15,
  '4k': 0.18,
};

// Tuzi default GPT Image 2：元 / 张。2026-09-04 用户公告及公开 /api/pricing 核对。
// 最终 size 精确命中白名单时算 1K，其余按总像素分档；不是最长边。
export const TUZI_GPT_IMAGE_2_YUAN_PER_IMAGE = {
  '1k': 0.028,
  '2k': 0.12,
  '4k': 0.21,
};
export const TUZI_GPT_IMAGE_2_PIXEL_LIMITS = { '1k': 1048576, '2k': 4194304 };
export const TUZI_GPT_IMAGE_2_1K_SIZES: ReadonlySet<string> = new Set([
  '1254x1254', '1024x1536', '1536x1024',
  '1086x1448', '1448x1086', '1122x1402', '1402x1122',
  '1672x941', '941x1672', '1915x821', '821x1915',
]);
// 独立固定价型号，不因用户传入的 size / quality 改价；厂商负责匹配最近比例。
export const TUZI_GPT_IMAGE_2_1K_YUAN_PER_IMAGE = 0.028;

// Tuzi：元 / 张；其他模型与分组沿用已有核价。
export const TUZI_GROUP_YUAN_PER_IMAGE: Record<string, Record<string, number>> = {
  default: {
    'doubao-seedream-4-5-251128': 0.12,
    'seedream-4-5': 0.12,
    'seedream-5-0-pro': 0.6,
    'nano-banana-2': 0.3,
    'nano-banana-2-2k': 0.48,
    'nano-banana-2-4k': 0.82,
  },
  '绘画': { 'gpt-image-2': 0.21 },
};
// 元 / 任务：一次 imagine 拆出四张图仍只计一次。
export const TUZI_MIDJOURNEY_YUAN_PER_TASK = 0.1505;

// TokenDance：元 / 张。
export const TOKEN_DANCE_YUAN_PER_IMAGE: Record<string, number> = {
  'seedream-5-0-lite': 0.22,
  'seedream-5-0-pro': 0.3,
};

// 火山 Ark 直连：元 / 张。
export const ARK_SEEDREAM_YUAN_PER_IMAGE: Record<string, number> = {
  'doubao-seedream-5-0-260128': 0.22,
  'doubao-seedream-4-5-251128': 0.25,
};

// 火山 Ark 直连 Seedance：元 / 百万输出 token。
export const ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS = {
  'doubao-seedance-2-0-fast-260128': 37,
  'doubao-seedance-2-0-260128': { standard: 46, '1080p': 51 },
  'doubao-seedance-1-5-pro-260428': { silent: 8, audio: 16 },
  'doubao-seedance-1-0-pro-250528': 15,
};

// 阿里 DashScope 直连 HappyHorse：元 / 秒；t2v / i2v / r2v 同价。
export const HAPPYHORSE_1_1_YUAN_PER_SECOND: Record<string, number> = {
  '480p': 0.45, '720p': 0.9, '1080p': 1.2,
};
export const HAPPYHORSE_1_0_YUAN_PER_SECOND: Record<string, number> = {
  '720p': 0.9, '1080p': 1.6,
};
