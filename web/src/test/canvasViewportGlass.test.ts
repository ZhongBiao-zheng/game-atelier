/**
 * 画布视口里不能有 backdrop-filter：WebKit（Safari、桌面版）会把含它的节点按 1 倍栅格化，
 * 再随画布缩放拉伸，放大后图片与文字一起发虚（.scratch/desktop-feel/PLAN.md 第 3 节）。
 * 节点里的玻璃浮层由 tokens.css 统一改成平底，这条守卫防止规则被删或改弱。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

declare const process: { cwd: () => string };

const tokens = readFileSync(`${process.cwd()}/src/styles/tokens.css`, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
const RULES = [...tokens.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.replace(/\s+/g, ' ').trim(),
  body: body.replace(/\s+/g, ' ').trim(),
}));

describe('canvas viewport glass', () => {
  it('strips backdrop-filter from everything inside the zoomed viewport', () => {
    const rule = RULES.find(item => item.selector === '.canvas-flow .react-flow__viewport *');
    expect(rule, 'tokens.css 缺少画布视口的 backdrop-filter 规则').toBeDefined();
    expect(rule!.body).toContain('backdrop-filter: none !important');
    expect(rule!.body).toContain('-webkit-backdrop-filter: none !important');
  });

  it('gives in-node glass a flat chip background in both themes', () => {
    const rule = RULES.find(item => item.selector === '.canvas-flow .react-flow__viewport .bg-glass');
    expect(rule?.body).toBe('background-color: var(--canvas-chip);');
    const chips = RULES.filter(item => /--canvas-chip:/.test(item.body)).map(item => item.selector);
    expect(chips).toEqual(expect.arrayContaining([':root', ':root.light']));
  });
});
