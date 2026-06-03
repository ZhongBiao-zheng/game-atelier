/** 各厂商/模型对参考图（图生图输入）数量的上限。超出按"取前 N 张"处理。
 *
 * - 火山引擎 Seedream：图生图最多 10 张参考图。
 * - gpt-image（OpenAI / OpenAI-HK，走 /v1/images/edits）：最多 16 张。
 * - nano-banana：官方建议「参考图片不超过 2 张效果更佳」，放宽到 3。
 * - 未知厂商：保守上限 4。
 */
export function maxReferenceImages(provider?: string | null, modelId?: string | null): number {
  if (provider === 'seedream') return 10;
  if (provider === 'nano_banana' || modelId?.startsWith('nano-banana')) return 3;
  if (provider === 'openai' || modelId?.startsWith('gpt-image')) return 16;
  return 4;
}
