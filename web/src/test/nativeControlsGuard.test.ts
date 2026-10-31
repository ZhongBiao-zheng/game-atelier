/**
 * 原生控件守卫 —— 页面只组合 components/ui，属性与配方集中在组件里（DESIGN.md § 组件）。
 *
 * - 页面禁写原生 input / textarea / select / button / label：防自动填充、焦点环、错误态等由 ui 组件统一提供。
 * - 页面禁用原生 title 提示，改用 Hint（Tooltip）。
 * - form 一律 autoComplete="off"。
 * - 任意值间距（p-[…]、gap-[…] 等）禁写，用 spacing 刻度。
 * - bare 控件是存量债务，走棘轮：只许减少，减少后把基线改成新数值。
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const sources = import.meta.glob('../**/*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const FILES = Object.entries(sources)
  .filter(([path]) => !path.endsWith('.test.tsx'))
  .map(([path, source]) => ({
    rel: path.replace(/^\.\.\//, ''),
    source,
    file: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  }));
const PAGES = FILES.filter(({ rel }) => !rel.startsWith('components/ui/'));

// 棘轮基线（2026-10-30）：bare 含 2026-10-30 从原生 button 迁来的 Button variant="bare"
const BARE_CONTROL_BASELINE = 183;

const ARBITRARY_SPACING = /(?<![\w-])-?(?:p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy])-\[/g;

function jsxElements(file: ts.SourceFile, visit: (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => void) {
  function walk(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) visit(node);
    ts.forEachChild(node, walk);
  }
  walk(file);
}

function where(file: ts.SourceFile, rel: string, node: ts.Node) {
  return `${rel}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
}

function expectRatchet(actual: number, baseline: number, what: string, hits: string[]) {
  expect(actual, `${what}新增了 ${actual - baseline} 处：\n${hits.join('\n')}`).toBeLessThanOrEqual(baseline);
  expect(actual, `${what}已减少到 ${actual}，把基线改成 ${actual}`).toBe(baseline);
}

describe('原生控件守卫（DESIGN.md § 组件）', () => {
  it('页面不写原生 input / textarea / select / button / label，改用 components/ui', () => {
    const hits: string[] = [];
    for (const { rel, file } of PAGES) {
      jsxElements(file, node => {
        if (['input', 'textarea', 'select', 'button', 'label'].includes(node.tagName.getText(file))) hits.push(where(file, rel, node));
      });
    }
    expect(hits, `用 Input / Textarea / Select / Checkbox / RadioGroup / Slider / FileInput / Button / Label：\n${hits.join('\n')}`).toEqual([]);
  });

  it('页面不用原生 title 提示，改用 Hint', () => {
    const hits: string[] = [];
    for (const { rel, file } of PAGES) {
      jsxElements(file, node => {
        const tag = node.tagName.getText(file);
        if (!/^[a-z]/.test(tag) || ['iframe', 'svg', 'title'].includes(tag)) return;
        if (node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'title')) {
          hits.push(where(file, rel, node));
        }
      });
    }
    expect(hits, `用 components/ui/tooltip 的 Hint：\n${hits.join('\n')}`).toEqual([]);
  });

  it('form 关闭自动填充', () => {
    const hits: string[] = [];
    for (const { rel, file } of FILES) {
      jsxElements(file, node => {
        if (node.tagName.getText(file) !== 'form') return;
        const ok = node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
          && attribute.name.getText(file) === 'autoComplete'
          && attribute.initializer !== undefined && ts.isStringLiteral(attribute.initializer)
          && attribute.initializer.text === 'off');
        if (!ok) hits.push(where(file, rel, node));
      });
    }
    expect(hits, `<form> 需要 autoComplete="off"：\n${hits.join('\n')}`).toEqual([]);
  });

  it('bare 控件只减不增（新代码用组件默认配方）', () => {
    const hits: string[] = [];
    for (const { rel, file } of PAGES) {
      jsxElements(file, node => {
        const bare = node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
          && attribute.name.getText(file) === 'variant'
          && attribute.initializer !== undefined && ts.isStringLiteral(attribute.initializer)
          && attribute.initializer.text === 'bare');
        if (bare) hits.push(where(file, rel, node));
      });
    }
    expectRatchet(hits.length, BARE_CONTROL_BASELINE, 'variant="bare" 控件', hits);
  });

  it('不写任意值间距，用 spacing 刻度（DESIGN.md § Spacing）', () => {
    const hits: string[] = [];
    for (const { rel, source } of FILES) {
      source.split('\n').forEach((line, i) => {
        for (const _ of line.matchAll(ARBITRARY_SPACING)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits, `p-[…] / gap-[…] 等改用刻度值（v4 支持 pt-3.5、gap-4.5 这类小数刻度）：\n${hits.join('\n')}`).toEqual([]);
  });
});
