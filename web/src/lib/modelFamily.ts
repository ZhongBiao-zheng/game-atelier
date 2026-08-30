/** 图像模型「族」判定 —— 四项能力判据（参考图上限 / quality / 最小像素 / 控件形态）的唯一 key。
 *
 * 唯一真值表：`tests/fixtures/capability-matrix.json`（Python 的 `openai_image.image_family`
 * 与本文件各自实现、共同对着那张表断言，见 `capabilityMatrix.test.ts`）。
 *
 * 规则：取 modelId 最后一个 '/' 之后的尾段（聚合商的 `openai/gpt-image-2` 这类 slug）→ lower()
 * → '_' 归一为 '-'（model-routing.md 给 Skill 的判据认 `nano_banana`）→ 子串匹配。
 *
 * **provider 不参与族判定**：同一个 gpt-image-2 走 OpenAI 直连还是过聚合商，能力是一样的；
 * provider 只决定端点与协议（如 OpenRouter 的 size 语义是比例串，那是传输层的事，不是族）。
 */
export type ImageFamily = 'gpt-image' | 'nano-banana' | 'seedream' | 'midjourney' | 'standard';

/** 族判定用的 id 归一：尾段 + lower + `_`→`-`。 */
export function normalizedModelId(modelId?: string | null): string {
  return (modelId ?? '').split('/').pop()!.toLowerCase().replace(/_/g, '-');
}

export function imageFamily(modelId?: string | null): ImageFamily {
  const id = normalizedModelId(modelId);
  // MJ 走任务代理协议（异步 submit + 轮询），控件形态与其余族完全不同：无尺寸、无质量，
  // 比例/版本/stylize 由渠道锁定。模型 id 形如 mj_fast_imagine / mj_relax_upscale。
  if (id.startsWith('mj-') || id.includes('midjourney') || id.startsWith('niji')) return 'midjourney';
  if (id.includes('gpt-image')) return 'gpt-image';
  if (id.includes('nano-banana')) return 'nano-banana';
  // seededit（图生图）与 seedream 同族：同一套尺寸下限与 10 张参考图上限。
  if (id.includes('seedream') || id.includes('seededit')) return 'seedream';
  return 'standard';
}

/** 图片 API 是否接受独立 quality 参数。
 *
 * Nano Banana 的无后缀型号用 low/medium/high 选档；Tuzi 等网关提供的 `-2k` / `-4k`
 * 固定型号已经把清晰度编码进 model id，前端不再暴露可自由选择的 quality；后端会从
 * model id 生成厂商计价路由需要的确定值。 */
export function supportsImageQuality(modelId?: string | null): boolean {
  const family = imageFamily(modelId);
  if (family === 'gpt-image') return true;
  if (family !== 'nano-banana') return false;
  return !/-(?:2k|4k)(?:-vip)?$/.test(normalizedModelId(modelId));
}
