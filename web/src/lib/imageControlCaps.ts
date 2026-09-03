/** 按模型族描述出图控件能力：决定尺寸面板里显示哪些 section、size 用什么语义传给后端。
 *
 * 判据一律走 `imageFamily(modelId)`（唯一真值表 tests/fixtures/capability-matrix.json）：
 * OpenAI-HK 这类聚合商 provider=custom，一个 key 下同时挂 gpt-image / nano-banana / seedream
 * 多个族，按 provider 判会把能力判错。
 *
 * 各族规格来自厂商文档：
 * - nano-banana：size 是比例枚举(不可自定义像素)；无后缀型号有质量档，固定 2K/4K
 *   型号的分辨率由模型名决定，不再叠加 quality。
 * - gpt-image：size 自由像素(最大边≤3840/双边16倍数/宽高比≤3:1)，有质量(含 auto)。
 * - seedream / standard：比例 + 2K/4K 分辨率 + 自定义像素，无质量。
 *
 * provider 只影响**传输语义**，不影响族：OpenRouter 的 Image API 收 aspect_ratio 比例串
 * 而不是像素，所以 provider=openrouter 时全族都改走比例、且不暴露分辨率/自定义像素
 * （后端 openrouter_image 会把 params.resolution 当 API 参数发出去，控件藏了还写就是静默计费）。
 */
import {
  imageFamily,
  normalizedModelId,
  supportsImageQuality,
  type ImageFamily,
} from '@/lib/modelFamily';
import { availableResolutions, type Resolution } from '@/lib/studioSize';

export type Quality = 'low' | 'medium' | 'high' | 'auto';

export interface ImageControlCaps {
  family: ImageFamily;
  /** 比例枚举（standard 族由 PromptInput 用 1:1 + 侧比例的特殊布局，此处仍给全集）。 */
  ratios: string[];
  /** 是否显示 2K/4K 分辨率切换。 */
  showResolution: boolean;
  /** 该模型真正可选的分辨率档位（按模型上限裁）；showResolution=false 时为空数组。
   *  seedream-5.0-pro 只回 ['2K'] —— 4K 档任意一挡都超它 4624220 的上限，给了就是给一个必错的选项。 */
  resolutions: Resolution[];
  /** 是否显示手动 W/H 自定义尺寸。 */
  showCustomSize: boolean;
  /** 质量选项；null 表示该族不暴露质量控件（也不该写进 job params）。 */
  qualities: Quality[] | null;
  /** size 传给后端的语义：'ratio' = 传比例字符串(如 16:9)；'pixels' = 传 WxH；
   *  'none' = 该族不接受任何尺寸参数，控件与 params 都不该出现尺寸（MJ：比例由渠道锁定）。 */
  sizeKind: 'ratio' | 'pixels' | 'none';
}

// 文档未列 1:1，但实测 nano-banana 支持（size="1:1" → 1024×1024）。
const NANO_BANANA_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2'];
const GPT_IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const STANDARD_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];

// OpenRouter Image API 通用比例（各厂商 clamp 到自己的子集；此集是 4 个精选模型的交集）。
const OPENROUTER_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];

// resolutions 不在这张表里：它按【模型】的像素上限裁，不是族属性（同族的 pro 与 lite 就不一样）。
const FAMILY_CAPS: Record<ImageFamily, Omit<ImageControlCaps, 'family' | 'resolutions'>> = {
  'nano-banana': {
    ratios: NANO_BANANA_RATIOS,
    showResolution: false,
    showCustomSize: false,
    qualities: ['low', 'medium', 'high'],
    sizeKind: 'ratio',
  },
  'gpt-image': {
    ratios: GPT_IMAGE_RATIOS,
    showResolution: false,
    showCustomSize: true,
    qualities: ['low', 'medium', 'high', 'auto'],
    sizeKind: 'pixels',
  },
  seedream: {
    ratios: STANDARD_RATIOS,
    showResolution: true,
    showCustomSize: true,
    qualities: null,
    sizeKind: 'pixels',
  },
  // MJ 任务代理协议：body 里没有 size / quality 字段，一切控制都在 prompt 尾部的 flag 里。
  // 比例照常可选（params.ratio 由后端拼成 --ar），但**没有像素尺寸**这回事 —— 输出边长由
  // MJ 自己定（实测 1024²），所以 sizeKind='none'：不发 size、不给分辨率档、不给自定义像素。
  // 质量也不是 quality 参数而是 --stylize / --q 一类 flag，走 MJ 专属控件而不是通用质量档。
  midjourney: {
    ratios: STANDARD_RATIOS,
    showResolution: false,
    showCustomSize: false,
    qualities: null,
    sizeKind: 'none',
  },
  standard: {
    ratios: STANDARD_RATIOS,
    showResolution: true,
    showCustomSize: true,
    qualities: null,
    sizeKind: 'pixels',
  },
};

export function imageControlCaps(
  modelId?: string | null,
  provider?: string | null,
  baseUrl?: string | null,
): ImageControlCaps {
  const family = imageFamily(modelId);
  const base = FAMILY_CAPS[family];
  const normalized = normalizedModelId(modelId);
  let isTuzi = false;
  try {
    const host = new URL(baseUrl ?? '').hostname.toLowerCase();
    isTuzi = host === 'tu-zi.com' || host.endsWith('.tu-zi.com');
  } catch {
    // Missing or relative URLs are not Tuzi endpoints.
  }
  // Tuzi 只有 Pro 与 2 的基础型号接收独立 quality；旧 2.5、HD/NT/VIP 的档位
  // 都编码在 model id。其他网关仍沿用共享的模型能力判定。
  const supportsTuziQuality = normalized === 'nano-banana-pro' || normalized === 'nano-banana-2';
  const qualities = supportsImageQuality(modelId) && (!isTuzi || supportsTuziQuality)
    ? base.qualities
    : null;
  // OpenRouter：size 走 aspect_ratio 比例语义（分辨率由厂商默认档决定），
  // 质量档位仍按模型能力给（固定 2K/4K Nano 型号不再叠加 quality）。
  if (provider === 'openrouter') {
    return {
      family,
      ratios: OPENROUTER_RATIOS,
      showResolution: false,
      resolutions: [],
      showCustomSize: false,
      qualities,
      sizeKind: 'ratio',
    };
  }
  return {
    family,
    ...base,
    qualities,
    resolutions: base.showResolution ? availableResolutions(modelId) : [],
  };
}

/** MJ 一次 imagine 回的方案数：上游把 2048² 四宫格切成 4 张 1024² 单图，一并落盘。
 *  张数不由画师定 —— 传小于 4 的 n 会让 job_runner 按 n 裁掉已经计费的图。 */
export const MJ_IMAGES_PER_TASK = 4;

export const QUALITY_LABELS: Record<Quality, string> = {
  low: '低',
  medium: '中',
  high: '高',
  auto: '自动',
};
