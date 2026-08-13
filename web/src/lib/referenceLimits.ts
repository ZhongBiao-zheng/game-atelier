/** 各模型族对参考图（图生图输入）数量的上限。超出按"取前 N 张"处理。
 *
 * 判据是**模型族**不是 provider（唯一真值表 tests/fixtures/capability-matrix.json）：
 * 同一个 doubao-seedream 走火山直连还是过 Tuzi 聚合，都吃 10 张；按 provider 判会把
 * 聚合商下的 seedream 砍到 4 张（砍掉 60% 能力，且界面上 10 个 chip 全在、后端只发前 4 张）。
 *
 * - seedream（含 seededit）：图生图最多 10 张参考图。
 * - gpt-image（走 /v1/images/edits）：最多 16 张。
 * - nano-banana：官方建议「参考图片不超过 2 张效果更佳」，放宽到 3。
 * - standard（未知族）：保守上限 4。
 */
import { imageFamily } from '@/lib/modelFamily';

const FAMILY_LIMITS = {
  seedream: 10,
  'gpt-image': 16,
  'nano-banana': 3,
  standard: 4,
} as const;

export function maxReferenceImages(modelId?: string | null): number {
  return FAMILY_LIMITS[imageFamily(modelId)];
}
