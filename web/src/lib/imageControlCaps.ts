/** 按模型族（modelId）描述出图控件能力：决定尺寸面板里显示哪些 section。
 *
 * 不再按 provider 判断——OpenAI-HK 这类聚合供应商 provider=custom，一个 key 下
 * 同时挂 gpt-image / nano-banana 多个模型族，只能按 modelId 区分。
 *
 * 各族规格来自厂商文档：
 * - nano-banana：size 是比例枚举(不可自定义像素)，有质量，分辨率靠模型名区分。
 * - gpt-image：size 自由像素(最大边≤3840/双边16倍数/宽高比≤3:1)，有质量(含 auto)。
 * - standard(seedream/默认)：比例 + 2K/4K 分辨率 + 自定义像素，无质量。
 */
export type Quality = 'low' | 'medium' | 'high' | 'auto';

export interface ImageControlCaps {
  family: 'nano-banana' | 'gpt-image' | 'openrouter' | 'standard';
  /** 比例枚举（standard 族由 PromptInput 用 1:1 + 侧比例的特殊布局，此处仍给全集）。 */
  ratios: string[];
  /** 是否显示 2K/4K 分辨率切换。 */
  showResolution: boolean;
  /** 是否显示手动 W/H 自定义尺寸。 */
  showCustomSize: boolean;
  /** 质量选项；null 表示该族不暴露质量控件。 */
  qualities: Quality[] | null;
  /** size 传给后端的语义：'ratio' = 传比例字符串(如 16:9)；'pixels' = 传 WxH。 */
  sizeKind: 'ratio' | 'pixels';
}

// 文档未列 1:1，但实测 nano-banana 支持（size="1:1" → 1024×1024）。
const NANO_BANANA_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2'];
const GPT_IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const STANDARD_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];

// OpenRouter Image API 通用比例（各厂商 clamp 到自己的子集；此集是 4 个精选模型的交集）。
const OPENROUTER_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];

export function imageControlCaps(modelId?: string | null): ImageControlCaps {
  // OpenRouter 模型 id 是 vendor/model 斜杠 slug（如 openai/gpt-image-2），现有各厂商
  // id 均无斜杠——含 '/' 即判 openrouter 族。size 走 aspect_ratio 比例语义（分辨率由
  // 厂商默认档决定），quality 仅 gpt-image 尾段支持。
  if (modelId?.includes('/')) {
    const tail = modelId.split('/').pop() ?? '';
    return {
      family: 'openrouter',
      ratios: OPENROUTER_RATIOS,
      showResolution: false,
      showCustomSize: false,
      qualities: tail.startsWith('gpt-image') ? ['low', 'medium', 'high', 'auto'] : null,
      sizeKind: 'ratio',
    };
  }
  if (modelId?.startsWith('nano-banana')) {
    return {
      family: 'nano-banana',
      ratios: NANO_BANANA_RATIOS,
      showResolution: false,
      showCustomSize: false,
      qualities: ['low', 'medium', 'high'],
      sizeKind: 'ratio',
    };
  }
  if (modelId?.startsWith('gpt-image')) {
    return {
      family: 'gpt-image',
      ratios: GPT_IMAGE_RATIOS,
      showResolution: false,
      showCustomSize: true,
      qualities: ['low', 'medium', 'high', 'auto'],
      sizeKind: 'pixels',
    };
  }
  return {
    family: 'standard',
    ratios: STANDARD_RATIOS,
    showResolution: true,
    showCustomSize: true,
    qualities: null,
    sizeKind: 'pixels',
  };
}

export const QUALITY_LABELS: Record<Quality, string> = {
  low: '低',
  medium: '中',
  high: '高',
  auto: '自动',
};
