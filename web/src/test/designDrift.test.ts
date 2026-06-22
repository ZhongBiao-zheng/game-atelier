/**
 * 设计漂移守卫 —— DESIGN.md 的硬约束执行层。
 *
 * 扫描 web/src 下所有非测试 tsx，按规则红灯。
 * 每条规则对应 DESIGN.md 的一个章节；改样式前先读 DESIGN.md。
 * 合理例外走 ALLOWLIST 逐条登记，不许扩大正则。
 */
import { describe, expect, it } from 'vitest';

// Vite 在 transform 期把全部非测试 tsx 以纯文本内联进来——不依赖 node API，
// tsconfig 只需 vite/client 类型（src/vite-env.d.ts）。
const RAW_SOURCES = import.meta.glob('../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface AllowEntry {
  file: string; // 相对 src/ 的路径
  pattern: string; // 命中行需包含的片段
  reason: string;
}

const ALLOWLIST: AllowEntry[] = [
  {
    file: 'components/AppShell.tsx',
    pattern: 'font-display text-2xl font-normal',
    reason: '品牌字标 "Atelier" 固定 24px serif —— 唯一介于 base 与 display 之间的例外',
  },
  {
    file: 'components/HomeDottedBackground.tsx',
    pattern: 'linear-gradient(to bottom',
    reason: 'canvas 波点的纵向淡出遮罩 —— 复刻 tapnow 的 hero mask，字面量是 canvas/mask 的固有媒介，非主题色',
  },
  {
    file: 'components/HomeDottedBackground.tsx',
    pattern: 'ctx.fillStyle',
    reason: 'canvas 逐点填充色由 rgb 数值动态拼成，无法走 class token —— 基础色已读 --foreground 跟随主题',
  },
];

const FILES = Object.entries(RAW_SOURCES)
  .filter(([path]) => !path.endsWith('.test.tsx'))
  .map(([path, content]) => ({
    rel: path.replace(/^\.\.\//, ''),
    lines: content.split('\n'),
  }));

function findViolations(rule: RegExp): string[] {
  const hits: string[] = [];
  for (const { rel, lines } of FILES) {
    lines.forEach((line: string, i: number) => {
      const m = line.match(rule);
      if (!m) return;
      const allowed = ALLOWLIST.some(
        (a) => a.file === rel && line.includes(a.pattern),
      );
      if (allowed) return;
      hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

function assertClean(rule: RegExp, designRef: string) {
  const hits = findViolations(rule);
  expect(
    hits,
    `${hits.length} 处违反 ${designRef}：\n${hits.join('\n')}`,
  ).toEqual([]);
}

describe('设计漂移守卫（DESIGN.md 硬约束）', () => {
  it('扫描器覆盖全部组件源码（glob 失效会让守卫静默空转）', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(30);
  });

  it('禁硬编码 hex 色 —— 颜色必须走 token（DESIGN.md § Color）', () => {
    assertClean(
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/,
      'DESIGN.md § Color（语义 token，无裸 hex）',
    );
  });

  it('禁裸 rgba()/rgb() —— 玻璃/遮罩走 --glass/--scrim（DESIGN.md § Elevation）', () => {
    assertClean(/\brgba?\(/, 'DESIGN.md § Elevation（bg-glass / bg-scrim / border token）');
  });

  it('禁任意值字号 text-[Npx]（DESIGN.md § Typography 字阶四档）', () => {
    assertClean(/text-\[\d+(?:\.\d+)?px\]/, 'DESIGN.md § Typography（xs/sm/base/display 四档）');
  });

  it('禁 text-lg/xl/2xl/3xl/4xl —— 唯一大跳跃是 text-display（DESIGN.md § Typography）', () => {
    assertClean(
      /\btext-(?:lg|xl|2xl|3xl|4xl)\b/,
      'DESIGN.md § Typography（区块标题用 text-base font-medium，hero 用 text-display）',
    );
  });

  it('禁 shadow-* —— 深度靠玻璃不靠阴影（DESIGN.md § Elevation）', () => {
    assertClean(/\bshadow-(?!none\b)/, 'DESIGN.md § Elevation（阴影全禁，浮层用玻璃配方）');
  });

  it('禁 rounded-[…] 与 bg-gradient（DESIGN.md § Layout / 反 AI Slop）', () => {
    assertClean(
      /rounded-\[|bg-gradient/,
      'DESIGN.md § Layout（圆角 6/10/16/20/full 层级）+ 反 AI Slop（无渐变）',
    );
  });

  it('禁杂牌 backdrop-blur —— 只许 backdrop-blur-glass（DESIGN.md § Elevation）', () => {
    assertClean(
      /backdrop-blur-(?:xs|sm|md|lg|xl|2xl|3xl)\b/,
      'DESIGN.md § Elevation（统一 28px 玻璃模糊）',
    );
  });
});
