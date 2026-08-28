import type { Quality } from '@/lib/imageControlCaps';
import type { KeyView } from '@/api/keys';
import type { JobParams } from '@/schema/jobs';

export interface GenerationCostRequest {
  provider?: {
    provider?: string | null;
    baseUrl?: string | null;
    billingGroup?: string | null;
  };
  model?: { id?: string | null; protocol?: string | null };
  kind: 'image' | 'video';
  count?: number;
  quality?: Quality;
  duration?: number;
  resolution?: string;
  ratio?: string;
  generateAudio?: boolean;
  hasReferenceVideo?: boolean;
}

const OPENAI_HK_FIXED_YUAN_PER_IMAGE: Record<string, number> = {
  'gpt-image-2': 0.08,
  'nano-banana': 0.2,
  'nano-banana-hd': 0.32,
};
const OPENAI_HK_NANO_BANANA_2_YUAN: Partial<Record<Quality, number>> = {
  low: 0.48,
  medium: 0.72,
  high: 1,
};

const TUZI_DEFAULT_YUAN_PER_IMAGE: Record<string, number> = {
  'gpt-image-2': 0.035,
  'doubao-seedream-4-5-251128': 0.12,
  'seedream-4-5': 0.12,
  'seedream-5-0-pro': 0.6,
  'nano-banana-pro': 0.072,
  'nano-banana-pro-2k': 0.32,
  'nano-banana-pro-4k': 0.35,
  'nano-banana-2': 0.3,
  'nano-banana-2-2k': 0.48,
  'nano-banana-2-4k': 0.82,
};
const TUZI_GROUP_YUAN_PER_IMAGE: Record<string, Record<string, number>> = {
  default: TUZI_DEFAULT_YUAN_PER_IMAGE,
  '绘画': { 'gpt-image-2': 0.21 },
};
const TOKEN_DANCE_YUAN_PER_IMAGE: Record<string, number> = {
  'seedream-5-0-lite': 0.22,
  'seedream-5-0-pro': 0.3,
};

const ARK_SEEDREAM_YUAN_PER_IMAGE: Record<string, number> = {
  'doubao-seedream-5-0-260128': 0.22,
  'doubao-seedream-4-5-251128': 0.25,
};

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

function estimateOpenAiHkImage(request: GenerationCostRequest): number | null {
  const model = normalize(request.model?.id);
  const unitPrice = model === 'nano-banana-2'
    ? (request.quality ? OPENAI_HK_NANO_BANANA_2_YUAN[request.quality] : undefined)
    : OPENAI_HK_FIXED_YUAN_PER_IMAGE[model];
  if (unitPrice == null) return null;
  return priced(unitPrice * safeCount(request.count));
}

function estimateTuziImage(request: GenerationCostRequest): number | null {
  const group = request.provider?.billingGroup?.trim();
  if (!group) return null;
  const model = normalize(request.model?.id);
  if (group === 'default' && model === 'mj-imagine') return 0.1505;
  const unitPrice = TUZI_GROUP_YUAN_PER_IMAGE[group]?.[model];
  return unitPrice == null ? null : priced(unitPrice * safeCount(request.count));
}

function estimateTokenDanceImage(request: GenerationCostRequest): number | null {
  const unitPrice = TOKEN_DANCE_YUAN_PER_IMAGE[normalize(request.model?.id)];
  return unitPrice == null ? null : priced(unitPrice * safeCount(request.count));
}

function estimateArkImage(request: GenerationCostRequest): number | null {
  const model = normalize(request.model?.id);
  const unitPrice = ARK_SEEDREAM_YUAN_PER_IMAGE[model];
  if (unitPrice == null) return null;
  return priced(unitPrice * safeCount(request.count));
}

function arkSeedanceRate(model: string, resolution: string, generateAudio: boolean): number | null {
  if (model === 'doubao-seedance-2-0-fast-260128') return 37;
  if (model === 'doubao-seedance-2-0-260128') return resolution === '1080p' ? 51 : 46;
  if (model === 'doubao-seedance-1-5-pro-260428') return generateAudio ? 16 : 8;
  if (model === 'doubao-seedance-1-0-pro-250528') return 15;
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
    return { '480p': 0.45, '720p': 0.9, '1080p': 1.2 }[resolution] ?? null;
  }
  if (HAPPYHORSE_1_0_MODELS.has(model)) {
    return { '720p': 0.9, '1080p': 1.6 }[resolution] ?? null;
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

  if (request.kind === 'image' && isTuzi(request.provider.baseUrl)) {
    return estimateTuziImage(request);
  }
  if (
    request.kind === 'image'
    && isOpenAiHk(request.provider.baseUrl)
    && protocolMatches(request.model.protocol, 'openai')
  ) {
    return estimateOpenAiHkImage(request);
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
  const quality = (params.quality === 'low' || params.quality === 'medium'
    || params.quality === 'high' || params.quality === 'auto')
    ? params.quality
    : undefined;
  return estimateGenerationCost({
    provider: {
      provider: selectedKey.provider,
      baseUrl: selectedKey.base_url,
      billingGroup: selectedKey.billing_group,
    },
    model: { id: modelId, protocol: selectedModel?.protocol },
    kind,
    count: typeof params.n === 'number' ? params.n : undefined,
    quality,
    duration: typeof params.duration === 'number' ? params.duration : undefined,
    resolution: typeof params.resolution === 'string' ? params.resolution : undefined,
    ratio: typeof params.ratio === 'string' ? params.ratio : undefined,
    generateAudio: params.generate_audio === true,
    hasReferenceVideo: Array.isArray(params.reference_videos)
      && params.reference_videos.length > 0,
  });
}

export function formatGenerationCost(amount: number): string {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  return `¥ ${rounded.toFixed(2).replace(/\.?0+$/, '')}`;
}
