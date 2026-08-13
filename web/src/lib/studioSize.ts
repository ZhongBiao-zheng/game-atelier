/** Studio 尺寸计算 —— 比例 + 2K/4K 档位 → 像素，以及按模型族的像素归一。
 *
 * 判据是**模型族**不是 provider（唯一真值表 tests/fixtures/capability-matrix.json）：
 * 旧代码按 `provider === 'seedream'` 选尺寸表，同一个 doubao-seedream 挂在 Tuzi / 词元跳动
 * （provider=custom/tokendance）下就掉进通用算法，界面显示 2048×1152、后端按像素下限改写成
 * 2560×1440 —— 静默改写。改成按族之后界面显示的就是真正会出的尺寸。
 */
import { imageFamily, normalizedModelId } from '@/lib/modelFamily';

type Resolution = '2K' | '4K';

// seedream 族像素下限（低于此值上游会拒或自动放大）。默认 3686400；
// 分档 key 按归一 id（尾段 + lower + `_`/`.` 归一为 `-`）做子串匹配 ——
// 同一个模型在不同网关下有 `seedream-5.0-pro` / `doubao-seedream-5-0-pro-xxx` 两种写法。
const SEEDREAM_MIN_PIXELS_DEFAULT = 3686400;
const SEEDREAM_MIN_PIXELS_BY_MODEL: Array<[string, number]> = [
  // 实测下限只要 921600，套默认值会让用户白付 4 倍像素。
  ['seedream-5-0-pro', 921600],
];

// seedream 族像素上限（高于此值上游直接 400 `image area must be at most N pixels`）。
// 默认 16777216 = 4096²，4K 档全部够得着；分档 key 与下限表同样按归一 id 子串匹配。
const SEEDREAM_MAX_PIXELS_DEFAULT = 16777216;
const SEEDREAM_MAX_PIXELS_BY_MODEL: Array<[string, number]> = [
  // 实测上限只有 4624220，不到别人三分之一 —— 4K 档最小的一挡 4096x2304 就是它的两倍。
  ['seedream-5-0-pro', 4624220],
];

/** 该模型的最小像素下限；null = 该族不做最小像素归一。
 *
 * gpt-image 返回 null：它不是「单一下限」而是一整套约束（最大边 / 双边 16 倍数 / 上下限像素），
 * 走 `normalizeGptImagePixelSize`。 */
export function familyMinPixels(modelId?: string | null): number | null {
  if (imageFamily(modelId) !== 'seedream') return null;
  const id = normalizedModelId(modelId).replace(/\./g, '-');
  for (const [key, px] of SEEDREAM_MIN_PIXELS_BY_MODEL) {
    if (id.includes(key)) return px;
  }
  return SEEDREAM_MIN_PIXELS_DEFAULT;
}

/** 该模型的最大像素上限；null = 该族不做最大像素归一（gpt-image 同样走自己那套）。 */
export function familyMaxPixels(modelId?: string | null): number | null {
  if (imageFamily(modelId) !== 'seedream') return null;
  const id = normalizedModelId(modelId).replace(/\./g, '-');
  for (const [key, px] of SEEDREAM_MAX_PIXELS_BY_MODEL) {
    if (id.includes(key)) return px;
  }
  return SEEDREAM_MAX_PIXELS_DEFAULT;
}

// seedream 族的 2K/4K 标准档（火山官方尺寸表，已满足默认像素下限）。
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
  modelId?: string | null,
): { w: number; h: number } {
  if (imageFamily(modelId) === 'seedream') {
    return SIZE_TABLE[resolution][ratio] ?? SIZE_TABLE[resolution]['1:1'];
  }
  const base = resolution === '4K' ? 4096 : 2048;
  if (ratio === '1:1') return { w: base, h: base };
  const [a, b] = ratio.split(':').map(Number);
  if (!a || !b) return { w: base, h: base };
  if (a >= b) return { w: base, h: Math.round((b / a) * base) };
  return { w: Math.round((a / b) * base), h: base };
}

export function studioSizeFor(ratio: string, resolution: Resolution, modelId?: string | null) {
  const { w, h } = computeStudioPixelSize(ratio, resolution, modelId);
  return `${w}x${h}`;
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

/** 按模型族归一化像素尺寸：gpt-image 走自由像素约束，seedream 钳进 [下限, 上限]，其余原样。
 *
 * seedream 的约束是双向的 —— 界面上选 4K 而模型上限只有 4624220 时，不钳制就会带着一个必被
 * 上游拒绝的尺寸提交（画师侧现象：选 4K 出图报 400）。这里钳完，输入框显示的就是真正会出的尺寸。 */
export function normalizeStudioPixelSizeForModel(
  size: { w: number; h: number },
  modelId?: string | null,
): { w: number; h: number } {
  if (imageFamily(modelId) === 'gpt-image') return normalizeGptImagePixelSize(size);
  const pixels = Math.max(1, size.w * size.h);
  const minPixels = familyMinPixels(modelId);
  if (minPixels !== null && pixels < minPixels) {
    // 向上取整：放大后仍差一个像素会被继续判为不足。
    const scale = Math.sqrt(minPixels / pixels);
    return { w: Math.ceil(size.w * scale), h: Math.ceil(size.h * scale) };
  }
  const maxPixels = familyMaxPixels(modelId);
  if (maxPixels !== null && pixels > maxPixels) {
    // 向下取整：缩小后多一个像素就仍然越界。
    const scale = Math.sqrt(maxPixels / pixels);
    return { w: Math.max(1, Math.floor(size.w * scale)), h: Math.max(1, Math.floor(size.h * scale)) };
  }
  return size;
}

export function normalizeStudioSizeForModel(size: string, modelId?: string | null): string {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return size;
  const normalized = normalizeStudioPixelSizeForModel(
    { w: Number(match[1]), h: Number(match[2]) },
    modelId,
  );
  return `${normalized.w}x${normalized.h}`;
}
