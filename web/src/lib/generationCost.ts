import { routeChannel } from '@/lib/modelRoutes';
import type { Quality } from '@/lib/imageControlCaps';
import type { KeyView } from '@/api/keys';
import type { JobParams } from '@/schema/jobs';
import {
  ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS,
  ARK_SEEDREAM_YUAN_PER_IMAGE,
  EVOLINK_MIDJOURNEY_USD_PER_REQUEST,
  GENERATION_USD_TO_CNY,
  HAPPYHORSE_1_0_YUAN_PER_SECOND,
  HAPPYHORSE_1_1_YUAN_PER_SECOND,
} from '@/lib/generationPrices';
import { parsePixelSize } from '@/lib/studioSize';

export interface GenerationCostRequest {
  provider?: {
    provider?: string | null;
    baseUrl?: string | null;
    billingGroup?: string | null;
  };
  model?: { id?: string | null; protocol?: string | null };
  kind: 'image' | 'video';
  count?: number;
  size?: string;
  quality?: Quality | '1k' | '2k' | '4k';
  sizeMode?: JobParams['size_mode'];
  duration?: number;
  resolution?: string;
  ratio?: string;
  generateAudio?: boolean;
  hasReferenceVideo?: boolean;
  imageEdit?: boolean;
}

const HAPPYHORSE_1_1_MODELS = new Set([
  'happyhorse-1-1-t2v',
  'happyhorse-1-1-i2v',
  'happyhorse-1-1-r2v',
]);
const HAPPYHORSE_1_0_MODELS = new Set([
  'happyhorse-1-0-t2v',
  'happyhorse-1-0-i2v',
  'happyhorse-1-0-r2v',
]);

const MODERN_SEEDANCE_DIMENSIONS: Record<string, Record<string, readonly [number, number]>> = {
  '480p': {
    '16:9': [864, 496], '4:3': [752, 560], '1:1': [640, 640],
    '3:4': [560, 752], '9:16': [496, 864], '21:9': [992, 432],
  },
  '720p': {
    '16:9': [1280, 720], '4:3': [1112, 834], '1:1': [960, 960],
    '3:4': [834, 1112], '9:16': [720, 1280], '21:9': [1470, 630],
  },
  '1080p': {
    '16:9': [1920, 1080], '4:3': [1664, 1248], '1:1': [1440, 1440],
    '3:4': [1248, 1664], '9:16': [1080, 1920], '21:9': [2206, 946],
  },
};

const LEGACY_SEEDANCE_DIMENSIONS: Record<string, Record<string, readonly [number, number]>> = {
  '480p': {
    '16:9': [864, 480], '4:3': [736, 544], '1:1': [640, 640],
    '3:4': [544, 736], '9:16': [480, 864], '21:9': [960, 416],
  },
  '720p': {
    '16:9': [1248, 704], '4:3': [1120, 832], '1:1': [960, 960],
    '3:4': [832, 1120], '9:16': [704, 1248], '21:9': [1504, 640],
  },
  '1080p': {
    '16:9': [1920, 1088], '4:3': [1664, 1248], '1:1': [1440, 1440],
    '3:4': [1248, 1664], '9:16': [1088, 1920], '21:9': [2176, 928],
  },
};

function normalize(value?: string | null): string {
  return (value ?? '').trim().toLowerCase().replace(/[._]/g, '-');
}

function safeCount(count?: number): number {
  return Number.isFinite(count) ? Math.max(1, Math.floor(count ?? 1)) : 1;
}

function hostname(baseUrl?: string | null): string {
  if (!baseUrl?.trim()) return '';
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isOpenAiHk(baseUrl?: string | null): boolean {
  return isDomain(hostname(baseUrl), 'openai-hk.com');
}

function isTuzi(baseUrl?: string | null): boolean {
  return isDomain(hostname(baseUrl), 'tu-zi.com');
}

function isArkDirect(provider?: GenerationCostRequest['provider']): boolean {
  const name = normalize(provider?.provider);
  const configuredBaseUrl = provider?.baseUrl?.trim();
  if (configuredBaseUrl) {
    return hostname(configuredBaseUrl) === 'ark.cn-beijing.volces.com';
  }
  return ['seedream', 'seedance', 'volces', 'volcengine-video'].includes(name);
}

function isDashScopeDirect(provider?: GenerationCostRequest['provider']): boolean {
  return hostname(provider?.baseUrl) === 'dashscope.aliyuncs.com';
}

function priced(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

function protocolMatches(protocol: string | null | undefined, expected: string): boolean {
  const actual = normalize(protocol);
  return !actual || actual === expected;
}

/** TokenDance 价格快照（服务启动时从其公开接口同步，`GET /api/pricing/tokendance`）。
 *  与服务端 generation_pricing._tokendance 同一套解析；没有快照的模型不估价。 */
export interface TokenDancePricing {
  items?: {
    id?: string;
    plans?: { unit?: string; rate?: string | number; range?: { lower?: number; upper?: number } }[];
    skus?: { specs?: Record<string, string>; rate?: string | number; unit?: string }[];
  }[];
}

let tokenDancePricing: Record<string, TokenDancePricing> = {};

export function setTokenDancePrices(models: Record<string, TokenDancePricing>): void {
  tokenDancePricing = models;
}

function pricingRate(value: unknown): number | null {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

function estimateTokenDanceImage(request: GenerationCostRequest): number | null {
  const items = tokenDancePricing[request.model?.id ?? '']?.items ?? [];
  const item = items.find(entry => /(generated_images|:images)$/.test(entry.id ?? ''));
  const plans = (item?.plans ?? []).filter(plan => plan.unit === 'images');
  const size = request.size ? parsePixelSize(request.size) : null;
  const kpixels = size ? size.w * size.h / 1000 : null;
  // 不知道输出尺寸时，只有各档同价才能估。
  const rates = new Set(plans.filter(plan => !plan.range || kpixels == null
    || ((plan.range.lower ?? 0) <= kpixels && (plan.range.upper == null || kpixels < plan.range.upper)))
    .map(plan => pricingRate(plan.rate)));
  if (rates.size !== 1) return null;
  const [rate] = [...rates];
  return rate == null ? null : priced(rate * safeCount(request.count));
}

function estimateTokenDanceVideo(request: GenerationCostRequest): number | null {
  const duration = request.duration;
  if (!Number.isFinite(duration) || (duration ?? 0) <= 0) return null;
  const resolution = (request.resolution ?? '').trim().toLowerCase();
  const video = request.hasReferenceVideo ? 'true' : 'false';
  const skus = (tokenDancePricing[request.model?.id ?? '']?.items ?? []).flatMap(item => item.skus ?? [])
    .filter(sku => {
      const skuResolution = (sku.specs?.resolution ?? '*').toLowerCase();
      return (skuResolution === '*' || skuResolution === resolution)
        && (sku.specs?.has_video ?? video) === video;
    });
  // 指定分辨率的价格优先于通配。
  const sku = skus.find(entry => (entry.specs?.resolution ?? '*') !== '*') ?? skus[0];
  const rate = pricingRate(sku?.rate);
  if (!sku || rate == null) return null;
  const count = safeCount(request.count);
  if (sku.unit === 'seconds') return priced(rate * duration! * count);
  if (sku.unit !== 'millionTokens') return null;
  const dimensions = MODERN_SEEDANCE_DIMENSIONS[resolution]?.[request.ratio?.trim() ?? ''];
  if (!dimensions) return null;
  return priced(duration! * dimensions[0] * dimensions[1] * 24 / 1024 * rate * count / 1_000_000);
}

function estimateArkImage(request: GenerationCostRequest): number | null {
  const model = normalize(request.model?.id);
  const unitPrice = ARK_SEEDREAM_YUAN_PER_IMAGE[model];
  if (unitPrice == null) return null;
  return priced(unitPrice * safeCount(request.count));
}

function arkSeedanceRate(model: string, resolution: string, generateAudio: boolean): number | null {
  const rates = ARK_SEEDANCE_YUAN_PER_MILLION_TOKENS;
  if (model === 'doubao-seedance-2-0-fast-260128') return rates[model];
  if (model === 'doubao-seedance-2-0-260128') {
    return rates[model][resolution === '1080p' ? '1080p' : 'standard'];
  }
  if (model === 'doubao-seedance-1-5-pro-260428') {
    return rates[model][generateAudio ? 'audio' : 'silent'];
  }
  if (model === 'doubao-seedance-1-0-pro-250528') return rates[model];
  return null;
}

function seedanceOutputPixels(model: string, resolution: string, ratio: string): number | null {
  const table = model === 'doubao-seedance-1-0-pro-250528'
    ? LEGACY_SEEDANCE_DIMENSIONS
    : MODERN_SEEDANCE_DIMENSIONS;
  const dimensions = table[resolution]?.[ratio];
  return dimensions ? dimensions[0] * dimensions[1] : null;
}

function estimateArkVideo(request: GenerationCostRequest): number | null {
  if (request.hasReferenceVideo) return null;
  const resolution = normalize(request.resolution);
  const ratio = request.ratio?.trim();
  const model = normalize(request.model?.id);
  const pixels = ratio ? seedanceOutputPixels(model, resolution, ratio) : null;
  const duration = request.duration;
  if (!pixels || !Number.isFinite(duration) || (duration ?? 0) <= 0) {
    return null;
  }
  const rate = arkSeedanceRate(model, resolution, Boolean(request.generateAudio));
  if (rate == null) return null;

  const outputTokens = (duration! * pixels * 24) / 1024;
  const amount = outputTokens * rate * safeCount(request.count) / 1_000_000;
  return priced(amount);
}

function happyHorseRate(model: string, resolution: string): number | null {
  if (HAPPYHORSE_1_1_MODELS.has(model)) {
    return HAPPYHORSE_1_1_YUAN_PER_SECOND[resolution] ?? null;
  }
  if (HAPPYHORSE_1_0_MODELS.has(model)) {
    return HAPPYHORSE_1_0_YUAN_PER_SECOND[resolution] ?? null;
  }
  return null;
}

function estimateDashScopeVideo(request: GenerationCostRequest): number | null {
  const model = normalize(request.model?.id);
  const duration = request.duration;
  const rate = happyHorseRate(model, normalize(request.resolution));
  if (rate == null || !Number.isFinite(duration) || (duration ?? 0) <= 0) {
    return null;
  }
  return priced(rate * duration! * safeCount(request.count));
}

/**
 * 单次生成的价格估算。规则必须同时命中真实渠道与模型；不能把直连官方价
 * 套到 TokenDance、OpenRouter 等聚合渠道。无法可靠计算时返回 null，调用方不展示费用。
 */
export function estimateGenerationCost(request: GenerationCostRequest): number | null {
  if (!request.model?.id || !request.provider) return null;

  if (request.kind === 'image' && request.provider.provider === 'evolink') {
    const host = hostname(request.provider.baseUrl);
    if ((host && host !== 'api.evolink.ai') || request.model.id !== 'mj-v8.2'
      || !protocolMatches(request.model.protocol, 'evolink')) return null;
    const route = request.imageEdit ? 'imageEdit' : 'generation';
    return priced(EVOLINK_MIDJOURNEY_USD_PER_REQUEST[route] * GENERATION_USD_TO_CNY);
  }
  if (request.kind === 'image' && isTuzi(request.provider.baseUrl)) {
    return null; // Tuzi prices are evaluated by the server from its current snapshot.
  }
  if (
    request.kind === 'image'
    && isOpenAiHk(request.provider.baseUrl)
  ) {
    return null; // OpenAI-HK prices are evaluated from the server snapshot.
  }
  if (request.kind === 'image' && normalize(request.provider.provider) === 'tokendance') {
    return estimateTokenDanceImage(request);
  }
  if (
    request.kind === 'image'
    && isArkDirect(request.provider)
    && protocolMatches(request.model.protocol, 'ark')
  ) {
    return estimateArkImage(request);
  }
  if (request.kind === 'video' && normalize(request.provider.provider) === 'tokendance') {
    return estimateTokenDanceVideo(request);
  }
  if (
    request.kind === 'video'
    && isArkDirect(request.provider)
    && protocolMatches(request.model.protocol, 'seedance')
  ) {
    return estimateArkVideo(request);
  }
  if (
    request.kind === 'video'
    && isDashScopeDirect(request.provider)
    && protocolMatches(request.model.protocol, 'dashscope')
  ) {
    return estimateDashScopeVideo(request);
  }
  return null;
}

/**
 * 把创作台 Job 参数还原成统一计价请求。完整创作台与首页紧凑入口必须共用这里，
 * 否则同一模型会因提交入口不同而有的历史记录带费用、有的没有。
 */
export function estimateGenerationCostForSubmission(
  selectedKey: KeyView | undefined,
  modelId: string,
  kind: 'image' | 'video',
  params: JobParams,
): number | null {
  if (!selectedKey) return null;
  const selectedModel = selectedKey.models.find((item) => item.id === modelId);
  const channel = selectedModel ? routeChannel(selectedKey, selectedModel) : null;
  const key = channel?.key ?? selectedKey;
  const model = channel?.model ?? selectedModel;
  const quality = (params.quality === 'low' || params.quality === 'medium'
    || params.quality === 'high' || params.quality === 'auto'
    || params.quality === '1k' || params.quality === '2k' || params.quality === '4k')
    ? params.quality
    : undefined;
  return estimateGenerationCost({
    provider: {
      provider: key.provider,
      baseUrl: key.base_url,
      billingGroup: key.billing_group,
    },
    model: { id: model?.id ?? modelId, protocol: model?.protocol },
    kind,
    count: typeof params.n === 'number' ? params.n : undefined,
    size: typeof params.size === 'string' ? params.size : undefined,
    sizeMode: params.size_mode,
    quality,
    duration: typeof params.duration === 'number' ? params.duration : undefined,
    resolution: typeof params.resolution === 'string' ? params.resolution : undefined,
    ratio: typeof params.ratio === 'string' ? params.ratio : undefined,
    generateAudio: params.generate_audio === true,
    hasReferenceVideo: Array.isArray(params.reference_videos)
      && params.reference_videos.length > 0,
    imageEdit: params.image_edit != null,
  });
}

export function formatGenerationCost(amount: number): string {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  return `¥ ${rounded.toFixed(2).replace(/\.?0+$/, '')}`;
}
