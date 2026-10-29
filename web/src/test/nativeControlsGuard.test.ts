/**
 * 原生控件守卫 —— 页面只组合 components/ui，属性与配方集中在组件里（DESIGN.md § 组件）。
 *
 * - 页面禁写原生 input / textarea / select：防自动填充、密钥遮挡等属性由 ui 组件统一提供。
 * - form 一律 autoComplete="off"。
 * - 原生 button、bare 控件、任意值间距是存量债务，走棘轮：只许减少，减少后把基线改成新数值。
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

// 棘轮基线（2026-10-29）
const RAW_BUTTON_BASELINE = 263;
const BARE_CONTROL_BASELINE = 52;
const ARBITRARY_SPACING_BASELINE = 5;

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
  it('页面不写原生 input / textarea / select，改用 components/ui', () => {
    const hits: string[] = [];
    for (const { rel, file } of PAGES) {
      jsxElements(file, node => {
        if (['input', 'textarea', 'select'].includes(node.tagName.getText(file))) hits.push(where(file, rel, node));
      });
    }
    expect(hits, `用 Input / SecretInput / Textarea / Select / Checkbox / Radio / Slider / FileInput：\n${hits.join('\n')}`).toEqual([]);
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

  it('原生 button 只减不增（新代码用 Button）', () => {
    const hits: string[] = [];
    for (const { rel, file } of PAGES) {
      jsxElements(file, node => {
        if (node.tagName.getText(file) === 'button') hits.push(where(file, rel, node));
      });
    }
    expectRatchet(hits.length, RAW_BUTTON_BASELINE, '原生 <button> ', hits);
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

  it('任意值间距只减不增（DESIGN.md § Spacing）', () => {
    const hits: string[] = [];
    for (const { rel, source } of FILES) {
      source.split('\n').forEach((line, i) => {
        for (const _ of line.matchAll(ARBITRARY_SPACING)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
    expectRatchet(hits.length, ARBITRARY_SPACING_BASELINE, '任意值间距 ', hits);
  });
});
