/** 能力矩阵防漂移测试 —— 直接读唯一真值表 `tests/fixtures/capability-matrix.json`。
 *
 * Python 端（`openai_image.image_family` / `_max_reference_images` / 尺寸下限）对着同一张表
 * 断言。要改任一端的判据，先改这张表，两端测试会同时把你挡住。
 *
 * 为什么不用 `import fixture from '...json'`：fixture 在仓库根，而 vite 的 root 是 `web/`
 * （这里有自己的 lockfile），跨出去的路径会被 `server.fs.allow` 拦下。fs 直读最稳。
 * 路径基准用 `import.meta.dirname` 而不是 `new URL(字面量, import.meta.url)` —— 后者会被 vite
 * 当静态资源引用改写成 `/@fs/...` 的 http URL，也不用 cwd（依赖从哪个目录起的 vitest）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { imageControlCaps } from './imageControlCaps';
import { imageFamily, type ImageFamily } from './modelFamily';
import { maxReferenceImages } from './referenceLimits';
import {
  availableResolutions,
  computeStudioPixelSize,
  familyMaxPixels,
  familyMinPixels,
  normalizeStudioPixelSizeForModel,
} from './studioSize';

interface MatrixCase {
  why: string;
  model: string;
  provider: string;
  family: ImageFamily;
  max_reference_images: number;
  supports_quality: boolean;
  min_pixels: number | null;
  max_pixels: number | null;
}

const FIXTURE = `${import.meta.dirname}/../../../tests/fixtures/capability-matrix.json`;
const CASES: MatrixCase[] = JSON.parse(readFileSync(FIXTURE, 'utf-8')).cases;

describe('能力矩阵（capability-matrix.json 是唯一真值表）', () => {
  it('真值表读到了 —— 路径写错会让整组断言静默空转', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(16);
  });

  for (const c of CASES) {
    it(`${c.model} @ ${c.provider} — ${c.why}`, () => {
      const caps = imageControlCaps(c.model, c.provider);
      expect(imageFamily(c.model)).toBe(c.family);
      expect(caps.family).toBe(c.family);
      expect(maxReferenceImages(c.model)).toBe(c.max_reference_images);
      expect(caps.qualities !== null).toBe(c.supports_quality);
      expect(familyMinPixels(c.model)).toBe(c.min_pixels);
      expect(familyMaxPixels(c.model)).toBe(c.max_pixels);
    });
  }

  // 上限这一侧是 2026-08-14 的真 bug：Studio 4K 档给 seedream-5.0-pro 发 4096x2304
  // （9437184 像素），是它 4624220 上限的两倍，上游当场 400。
  for (const c of CASES.filter((x) => x.min_pixels !== null)) {
    it(`${c.model} — 任何输入尺寸归一后都落在 [${c.min_pixels}, ${c.max_pixels}]`, () => {
      for (const raw of [
        { w: 960, h: 960 },
        { w: 2048, h: 2048 },
        { w: 2560, h: 1440 },
        { w: 4096, h: 2304 },
        { w: 4096, h: 4096 },
        { w: 8192, h: 8192 },
      ]) {
        const out = normalizeStudioPixelSizeForModel(raw, c.model);
        const px = out.w * out.h;
        expect(px, `${raw.w}x${raw.h} → ${out.w}x${out.h}`).toBeGreaterThanOrEqual(c.min_pixels!);
        expect(px, `${raw.w}x${raw.h} → ${out.w}x${out.h}`).toBeLessThanOrEqual(c.max_pixels!);
      }
    });
  }

  it('上限是模型属性：同一网关同一把 key，pro 要钳、lite 原样通过', () => {
    const fourK = { w: 4096, h: 2304 };
    expect(normalizeStudioPixelSizeForModel(fourK, 'seedream-5.0-lite')).toEqual(fourK);
    expect(normalizeStudioPixelSizeForModel(fourK, 'doubao-seedream-4-5-251128')).toEqual(fourK);
    const clamped = normalizeStudioPixelSizeForModel(fourK, 'seedream-5.0-pro');
    expect(clamped).not.toEqual(fourK);
    expect(clamped.w * clamped.h).toBeLessThanOrEqual(4624220);
    expect(Math.abs(clamped.w / clamped.h - 16 / 9)).toBeLessThan(0.01); // 比例要保住
  });

  it('provider 不参与族判定：同一模型换 provider 四项判据完全一致', () => {
    const byModel = new Map<string, MatrixCase[]>();
    for (const c of CASES) {
      byModel.set(c.model, [...(byModel.get(c.model) ?? []), c]);
    }
    const shared = [...byModel.values()].filter((group) => group.length > 1);
    expect(shared.length).toBeGreaterThan(0); // 表里必须留着「同模型跨 provider」的对照组
    for (const group of shared) {
      const families = new Set(group.map((c) => c.family));
      const limits = new Set(group.map((c) => c.max_reference_images));
      expect(families.size).toBe(1);
      expect(limits.size).toBe(1);
    }
  });

  it('openrouter 只改 size 语义，不改族 —— provider 是端点/协议层', () => {
    const direct = imageControlCaps('gpt-image-2', 'openai');
    const routed = imageControlCaps('openai/gpt-image-2', 'openrouter');
    expect(routed.family).toBe(direct.family);
    expect(routed.qualities).toEqual(direct.qualities);
    expect(direct.sizeKind).toBe('pixels');
    // 比例串语义 + 藏起分辨率/自定义像素：后端 openrouter_image 会把 params.resolution
    // 当 API 参数发出去，控件藏了还写 = 按 4K 计费。
    expect(routed.sizeKind).toBe('ratio');
    expect(routed.showResolution).toBe(false);
    expect(routed.showCustomSize).toBe(false);
  });
});

// 2026-08-14：pro 的上限 4624220 够不着 4K 档任意一挡。与其让画师选一个必然 400 的档位，
// 不如不给这个选项；而唯一剩下的 2K 档要撑满上限，否则标准 2K 表只用掉 90.7% 的额度。
describe('分辨率档位按模型上限裁', () => {
  const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
  const PRO_MAX = 4624220;
  // lite 的上限是 16777216（=4096²），4K 表原样通过，拿它当「标准表」的取值口。
  const std = (ratio: string, res: '2K' | '4K') => computeStudioPixelSize(ratio, res, 'seedream-5.0-lite');

  for (const c of CASES.filter((x) => x.max_pixels !== null)) {
    it(`${c.model} — 可选档位与 4K 可达性一致`, () => {
      const anyFits = RATIOS.some((r) => {
        const s = std(r, '4K');
        return s.w * s.h <= c.max_pixels!;
      });
      expect(availableResolutions(c.model)).toEqual(anyFits ? ['2K', '4K'] : ['2K']);
    });
  }

  it('非 seedream 族不受影响（上限为 null → 两档都在）', () => {
    expect(availableResolutions('dall-e-3')).toEqual(['2K', '4K']);
    expect(availableResolutions(undefined)).toEqual(['2K', '4K']);
  });

  it('只剩 2K 的模型：这一档撑满上限、不越界、比例不变', () => {
    for (const r of RATIOS) {
      const s = computeStudioPixelSize(r, '2K', 'seedream-5.0-pro');
      const px = s.w * s.h;
      expect(px, `${r} → ${s.w}x${s.h}`).toBeLessThanOrEqual(PRO_MAX);
      // 真撑满了：照搬标准 2K 表只有 4194304/4624220 = 90.7%，达不到 99%。
      expect(px, `${r} → ${s.w}x${s.h}`).toBeGreaterThan(PRO_MAX * 0.99);
      const ref = std(r, '2K');
      expect(Math.abs(s.w / s.h - ref.w / ref.h), `${r} 比例`).toBeLessThan(0.01);
    }
  });

  it('状态里残留 4K 也不会越界：pro 无视传入档位', () => {
    // 从 lite 切到 pro 时 resolution 状态可能还是 4K，纠偏 effect 落地前会先渲染一帧。
    expect(computeStudioPixelSize('16:9', '4K', 'seedream-5.0-pro'))
      .toEqual(computeStudioPixelSize('16:9', '2K', 'seedream-5.0-pro'));
  });

  it('lite / 4-5 的 4K 档一个像素都不动', () => {
    expect(std('16:9', '4K')).toEqual({ w: 4096, h: 2304 });
    expect(computeStudioPixelSize('1:1', '4K', 'doubao-seedream-4-5-251128')).toEqual({ w: 4096, h: 4096 });
  });

  it('caps.resolutions 跟着模型走，不跟着族走', () => {
    expect(imageControlCaps('seedream-5.0-pro', 'tokendance').resolutions).toEqual(['2K']);
    expect(imageControlCaps('seedream-5.0-lite', 'tokendance').resolutions).toEqual(['2K', '4K']);
    // 不显示分辨率控件的族给空数组，PromptInput 的纠偏 effect 靠 showResolution 提前 return。
    expect(imageControlCaps('gpt-image-2', 'openai').resolutions).toEqual([]);
    expect(imageControlCaps('openai/gpt-image-2', 'openrouter').resolutions).toEqual([]);
  });
});
