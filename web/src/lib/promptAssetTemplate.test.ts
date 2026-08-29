import { describe, expect, it } from 'vitest';

import {
  addPromptVariableRange,
  promptTemplateFromSegments,
  segmentsFromPromptTemplate,
  updatePromptVariableRanges,
} from './promptAssetTemplate';

describe('prompt asset template editing', () => {
  it('round-trips variables without inserting whitespace', () => {
    const template = promptTemplateFromSegments([
      { kind: 'text', text: '一只' },
      { kind: 'variable', name: '主体', default_value: '白色三头犬' },
      { kind: 'text', text: '站在火山口中。' },
    ]);
    expect(template.text).toBe('一只白色三头犬站在火山口中。');
    expect(segmentsFromPromptTemplate(template.text, template.variables)).toEqual([
      { kind: 'text', text: '一只' },
      { kind: 'variable', name: '主体', default_value: '白色三头犬' },
      { kind: 'text', text: '站在火山口中。' },
    ]);
  });

  it('rejects overlapping variable ranges and keeps the selected text in place', () => {
    const first = addPromptVariableRange([], { name: '主体', start: 2, end: 7 });
    expect(addPromptVariableRange(first, { name: '重叠', start: 4, end: 8 })).toBe(first);
    expect(segmentsFromPromptTemplate('一只白色三头犬', first)[1]).toEqual({
      kind: 'variable',
      name: '主体',
      default_value: '白色三头犬',
    });
  });

  it('removes variable identity without removing or spacing the original text', () => {
    const template = promptTemplateFromSegments([
      { kind: 'text', text: '一只' },
      { kind: 'variable', name: '主体', default_value: '白犬' },
      { kind: 'text', text: '奔跑' },
    ]);
    expect(segmentsFromPromptTemplate(template.text, [])).toEqual([
      { kind: 'text', text: '一只白犬奔跑' },
    ]);
  });

  it('tracks edits inside variables and drops markers crossed by a broad replacement', () => {
    const ranges = [{ id: 'subject', name: '主体', start: 2, end: 7 }];
    expect(updatePromptVariableRanges('一只白色三头犬', '一只毛绒白色三头犬', ranges))
      .toEqual([{ id: 'subject', name: '主体', start: 2, end: 9 }]);
    expect(updatePromptVariableRanges('一只白色三头犬', '完全重写', ranges)).toEqual([]);
  });
});
