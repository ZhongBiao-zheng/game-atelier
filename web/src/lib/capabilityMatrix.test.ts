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
import { familyMinPixels } from './studioSize';

interface MatrixCase {
  why: string;
  model: string;
  provider: string;
  family: ImageFamily;
  max_reference_images: number;
  supports_quality: boolean;
  min_pixels: number | null;
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
    });
  }

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
