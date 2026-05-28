type Resolution = '2K' | '4K';

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
