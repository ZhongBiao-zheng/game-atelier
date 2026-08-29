import { describe, expect, it } from 'vitest';

import { renderCreationPrompt, type CreationPromptSegment } from './creationAssets';

const segments: CreationPromptSegment[] = [
  { kind: 'text', text: '一只' },
  { kind: 'variable', name: '主体', default_value: '白色三头犬' },
  { kind: 'text', text: '站在' },
  { kind: 'variable', name: '场景', default_value: '火山口' },
  { kind: 'text', text: '中。' },
];

describe('renderCreationPrompt', () => {
  it('joins variable values without injecting whitespace', () => {
    expect(renderCreationPrompt(segments)).toBe('一只白色三头犬站在火山口中。');
    expect(renderCreationPrompt(segments, { 主体: '机械犬', 场景: '月面' }))
      .toBe('一只机械犬站在月面中。');
  });

  it('uses the default content when a variable is blank', () => {
    expect(renderCreationPrompt(segments, { 主体: '   ' }))
      .toBe('一只白色三头犬站在火山口中。');
  });
});
