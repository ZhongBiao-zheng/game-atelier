import { describe, expect, it } from 'vitest';
import { promptFromAsset, promptToAssetSegments, promptVariableError, promptVariableParts, promptVariableToken, readablePromptVariables, resolvePromptVariables } from './promptVariables';

describe('inline prompt variables', () => {
  it('keeps the draft empty but uses defaults for generation and readable text', () => {
    const segments = [{ kind: 'text' as const, text: '画一只' }, { kind: 'variable' as const, name: '主体', default_value: '白猫' }];
    const prompt = promptFromAsset(segments);
    expect(promptVariableError(prompt)).toBeNull();
    expect(resolvePromptVariables(prompt)).toBe('画一只白猫');
    expect(readablePromptVariables(prompt)).toBe('画一只白猫');
    expect(promptToAssetSegments(prompt)).toEqual(segments);
  });
  it('uses defaults for whitespace, explicit values first, and requires content without defaults', () => {
    const token = (value: string, example = '水墨') => promptVariableToken({ name: '风格', example, value });
    expect(resolvePromptVariables(token(' \n'))).toBe('水墨');
    expect(resolvePromptVariables(token(' 水彩 '))).toBe(' 水彩 ');
    expect(() => resolvePromptVariables(token('', '  '))).toThrow('请填写');
    expect(resolvePromptVariables(token('') + token('水墨'))).toBe('水墨水墨');
    expect(() => resolvePromptVariables(token('') + token('', '水彩'))).toThrow('不一致');
  });
  it('round-trips unicode, delimiters, HTML and newlines as literal data', () => {
    const variable = { name: '主体', example: '猫 ] : %', value: '<b>雪山</b>\n@[variable:literal]' };
    const token = promptVariableToken(variable);
    expect(promptVariableParts(token)).toEqual([{ kind: 'variable', variable }]);
    expect(resolvePromptVariables(token)).toBe(variable.value);
  });
  it('rejects broken tokens and conflicting values, but supports repeated values', () => {
    for (const bad of ['@[variable:nope]', '@[variable:%]', '@[variable:', '@[variable:%7B%7D]']) {
      expect(() => resolvePromptVariables(bad)).toThrow();
    }
    const token = (value: string) => promptVariableToken({ name: '主体', example: '猫', value });
    expect(() => resolvePromptVariables(token('猫') + token('狗'))).toThrow('不一致');
    expect(resolvePromptVariables(token('猫') + '和' + token('猫'))).toBe('猫和猫');
  });
});
