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
export type ImageFamily = 'gpt-image' | 'nano-banana' | 'seedream' | 'standard';

/** 族判定用的 id 归一：尾段 + lower + `_`→`-`。 */
export function normalizedModelId(modelId?: string | null): string {
  return (modelId ?? '').split('/').pop()!.toLowerCase().replace(/_/g, '-');
}

export function imageFamily(modelId?: string | null): ImageFamily {
  const id = normalizedModelId(modelId);
  if (id.includes('gpt-image')) return 'gpt-image';
  if (id.includes('nano-banana')) return 'nano-banana';
  // seededit（图生图）与 seedream 同族：同一套尺寸下限与 10 张参考图上限。
  if (id.includes('seedream') || id.includes('seededit')) return 'seedream';
  return 'standard';
}
