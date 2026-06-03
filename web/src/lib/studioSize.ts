type Resolution = '2K' | '4K';

export const SEEDREAM_MIN_PIXELS = 3686400;

const SIZE_TABLE: Record<Resolution, Record<string, { w: number; h: number }>> = {
  '2K': {
    '1:1': { w: 2048, h: 2048 },
    '4:3': { w: 2304, h: 1728 },
    '3:4': { w: 1728, h: 2304 },
    '16:9': { w: 2560, h: 1440 },
    '9:16': { w: 1440, h: 2560 },
    '3:2': { w: 2496, h: 1664 },
    '2:3': { w: 1664, h: 2496 },
    '21:9': { w: 3024, h: 1296 },
  },
  '4K': {
    '1:1': { w: 4096, h: 4096 },
    '4:3': { w: 4096, h: 3072 },
    '3:4': { w: 3072, h: 4096 },
    '16:9': { w: 4096, h: 2304 },
    '9:16': { w: 2304, h: 4096 },
    '3:2': { w: 4096, h: 2731 },
    '2:3': { w: 2731, h: 4096 },
    '21:9': { w: 4096, h: 1755 },
  },
};

export function computeStudioPixelSize(
  ratio: string,
  resolution: Resolution,
  provider?: string | null,
): { w: number; h: number } {
  if (provider === 'seedream') {
    return SIZE_TABLE[resolution][ratio] ?? SIZE_TABLE[resolution]['1:1'];
  }
  const base = resolution === '4K' ? 4096 : 2048;
  if (ratio === '1:1') return { w: base, h: base };
  const [a, b] = ratio.split(':').map(Number);
  if (!a || !b) return { w: base, h: base };
  if (a >= b) return { w: base, h: Math.round((b / a) * base) };
  return { w: Math.round((a / b) * base), h: base };
}

export function studioSizeFor(ratio: string, resolution: Resolution, provider?: string | null) {
  const { w, h } = computeStudioPixelSize(ratio, resolution, provider);
  return `${w}x${h}`;
}

export function normalizeStudioPixelSizeForProvider(
  size: { w: number; h: number },
  provider?: string | null,
): { w: number; h: number } {
  if (provider !== 'seedream' || size.w * size.h >= SEEDREAM_MIN_PIXELS) {
    return size;
  }
  const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / Math.max(1, size.w * size.h));
  return {
    w: Math.ceil(size.w * scale),
    h: Math.ceil(size.h * scale),
  };
}

export function normalizeStudioSizeForProvider(size: string, provider?: string | null): string {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return size;
  const normalized = normalizeStudioPixelSizeForProvider(
    { w: Number(match[1]), h: Number(match[2]) },
    provider,
  );
  return `${normalized.w}x${normalized.h}`;
}

// gpt-image 尺寸约束（OpenAI-HK 文档）：最大边 ≤3840、双边 16 倍数、总像素 65.5万~829万。
const GPT_MAX_EDGE = 3840;
const GPT_MIN_PIXELS = 655360;
const GPT_MAX_PIXELS = 8294400;
const round16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

export function normalizeGptImagePixelSize(size: { w: number; h: number }): { w: number; h: number } {
  let { w, h } = size;
  const maxEdge = Math.max(w, h);
  if (maxEdge > GPT_MAX_EDGE) {
    const s = GPT_MAX_EDGE / maxEdge;
    w *= s;
    h *= s;
  }
  const px = w * h;
  if (px > GPT_MAX_PIXELS) {
    const s = Math.sqrt(GPT_MAX_PIXELS / px);
    w *= s;
    h *= s;
  } else if (px < GPT_MIN_PIXELS) {
    const s = Math.sqrt(GPT_MIN_PIXELS / px);
    w *= s;
    h *= s;
  }
  return { w: round16(w), h: round16(h) };
}

/** 按模型族归一化像素尺寸：gpt-image 走自由像素约束，其余沿用 provider 规则。 */
export function normalizeStudioPixelSizeForModel(
  size: { w: number; h: number },
  provider?: string | null,
  modelId?: string | null,
): { w: number; h: number } {
  if (modelId?.startsWith('gpt-image')) return normalizeGptImagePixelSize(size);
  return normalizeStudioPixelSizeForProvider(size, provider);
}

export function normalizeStudioSizeForModel(
  size: string,
  provider?: string | null,
  modelId?: string | null,
): string {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return size;
  const normalized = normalizeStudioPixelSizeForModel(
    { w: Number(match[1]), h: Number(match[2]) },
    provider,
    modelId,
  );
  return `${normalized.w}x${normalized.h}`;
}
