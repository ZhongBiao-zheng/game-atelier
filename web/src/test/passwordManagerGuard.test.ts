import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const sources = import.meta.glob('../**/*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
const expected = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-form-type': 'other',
};

describe('password manager opt-out guard', () => {
  it('marks every native input and textarea, and disables form autocomplete', () => {
    const violations: string[] = [];
    let controls = 0;
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith('.test.tsx')) continue;
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(file);
          if (tag === 'input' || tag === 'textarea' || tag === 'form') {
            controls += 1;
            const attributes = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map(attribute => [
              attribute.name.getText(file),
              attribute.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : null,
            ]));
            const required = tag === 'form' ? { autoComplete: 'off' } : expected;
            for (const [name, value] of Object.entries(required)) {
              if (attributes.get(name) !== value) {
                const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
                violations.push(`${path}:${line + 1} <${tag}> requires ${name}="${value}"`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
    expect(controls).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
