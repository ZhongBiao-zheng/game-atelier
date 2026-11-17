/**
 * 深色主题守卫：浅色主题的差异只能写在 tokens.css 的 :root.light 规则里，深色 token 与深色玻璃配方一律不动。
 * 改深色是有意的设计决定时，同步改这里的表并在 DESIGN.md 决策日志记一条。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

declare const process: { cwd: () => string };

const tokens = readFileSync(`${process.cwd()}/src/styles/tokens.css`, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 最内层规则：{ selector, body }，选择器与规则体都压掉多余空白 */
const RULES = [...tokens.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.replace(/\s+/g, ' ').trim(),
  body: body.replace(/\s+/g, ' ').trim(),
}));

function body(selector: string): string {
  const found = RULES.find(item => item.selector === selector);
  expect(found, `tokens.css 缺少 ${selector}`).toBeDefined();
  return found!.body;
}

function declarations(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const DARK_TOKENS: Record<string, string> = {
  '--panel': '#111113',
  '--sidebar': '#0A0A0B',
  '--subtle-foreground': '#5C5C61',
  '--brand-2': '#6FD6F0',
  '--brand-3': '#F5D06A',
  '--brand-4': '#A99FF5',
  '--chart-1': '#6FD6F0',
  '--chart-2': '#F58FBD',
  '--chart-3': '#CDEB4A',
  '--chart-4': '#A99FF5',
  '--chart-5': '#F5D06A',
  '--background': '#0A0A0B',
  '--foreground': '#EDEDEF',
  '--card': '#18181B',
  '--card-foreground': '#EDEDEF',
  '--popover': '#1C1C1F',
  '--popover-foreground': '#EDEDEF',
  '--primary': '#D4F53C',
  '--primary-foreground': '#0A0A0B',
  '--secondary': '#26262A',
  '--secondary-foreground': '#EDEDEF',
  '--muted': '#18181B',
  '--muted-foreground': '#8E8E93',
  '--accent': '#26262A',
  '--accent-foreground': '#EDEDEF',
  '--destructive': '#E5534B',
  '--destructive-foreground': '#FFFFFF',
  '--glass': 'rgba(17, 17, 19, 0.66)',
  '--canvas-chip': 'rgba(17, 17, 19, 0.88)',
  '--scrim': 'rgba(0, 0, 0, 0.62)',
  '--border': 'rgba(255, 255, 255, 0.08)',
  '--input': 'rgba(255, 255, 255, 0.14)',
  '--ring': '#D4F53C',
  '--hairline-inset': 'rgba(255, 255, 255, 0.12)',
  '--scrim-soft': 'rgba(0, 0, 0, 0.16)',
  '--nav-ring-stroke': 'rgba(255, 255, 255, 0.45)',
  '--media-edge': 'rgba(255, 255, 255, 0.08)',
  '--status-pending': '#5C5C61',
  '--status-running': '#F2A33A',
  '--status-done': '#52AB69',
  '--status-failed': '#E5534B',
  '--motion-fast': '150ms',
  '--motion-base': '200ms',
  '--motion-slow': '300ms',
  '--ease-atelier-out': 'cubic-bezier(0.215, 0.61, 0.355, 1)',
  '--ease-atelier-in': 'cubic-bezier(0.55, 0.055, 0.675, 0.19)',
};

describe('深色主题守卫', () => {
  it(':root 深色 token 与定稿表逐项一致', () => {
    expect(declarations(body(':root'))).toEqual(DARK_TOKENS);
  });

  it('深色玻璃配方（导航药丸、按钮高光、浮层微阴影）不被改动', () => {
    expect(body('.nav-tab-glass')).toBe('border-top: 1px solid rgba(237, 234, 227, 0.22); border-bottom: 1px solid rgba(237, 234, 227, 0.07);');
    expect(body('.glass-specular')).toBe('border-top: 1px solid rgba(237, 234, 227, 0.14);');
    expect(body('.shell-glow')).toBe('box-shadow: 0 0.5px 0 0 var(--hairline-inset) inset, 0 4px 16px 0 var(--scrim-soft);');
    expect(body('.nav-active-ring::before')).toContain('var(--nav-ring-stroke) 90deg');
  });

  it('浅色专属的投影 token 与按钮标记类只在 :root.light 下生效', () => {
    expect(Object.keys(declarations(body(':root'))).filter(name => name.startsWith('--elevation-'))).toEqual([]);
    expect(Object.keys(declarations(body(':root.light')))).toEqual(expect.arrayContaining(['--elevation-float', '--elevation-raised']));
    const lightOnly = RULES.filter(({ selector, body: text }) =>
      /\.btn-(?:default|destructive|outline|secondary)\b/.test(selector) || /var\(--elevation-/.test(text));
    expect(lightOnly.length).toBeGreaterThan(0);
    expect(lightOnly.filter(({ selector }) => !selector.startsWith(':root.light')).map(({ selector }) => selector)).toEqual([]);
  });
});
