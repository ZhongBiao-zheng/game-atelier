import { describe, expect, it } from 'vitest';

import type { PluginInput } from '../../../sdk';
import { outputCount, parseTween, tweenSequence } from './tweenState';

const input = (handle: string, group: string | null = null, kind: PluginInput['kind'] = 'image'): PluginInput => (
  { handle, kind, title: handle, width: 8, height: 8, group });

describe('补间的帧序列', () => {
  it('连了结果组就按组内顺序取整组', () => {
    const result = tweenSequence([input('a', 'a'), input('b', 'a'), input('c', 'a'), input('x')], false);
    expect(result.kind).toBe('group');
    expect(result.items.map(item => item.handle)).toEqual(['a', 'b', 'c']);
  });

  it('两张单独的图按连线顺序，可交换首尾', () => {
    expect(tweenSequence([input('a'), input('b')], false).items.map(item => item.handle)).toEqual(['a', 'b']);
    expect(tweenSequence([input('a'), input('b')], true).items.map(item => item.handle)).toEqual(['b', 'a']);
  });

  it('不足两帧时没有序列', () => {
    expect(tweenSequence([input('a')], false).kind).toBe('none');
    expect(tweenSequence([input('v', null, 'video'), input('a')], false).kind).toBe('none');
  });
});

describe('补间的输出帧数与节点数据', () => {
  it('完整序列含原帧，只要补出的帧不含', () => {
    expect(outputCount(4, { between: 3, output: 'all' })).toBe(13);
    expect(outputCount(4, { between: 3, output: 'new' })).toBe(9);
  });

  it('坏值回落到默认值', () => {
    expect(parseTween({ method: 'morph', between: 99, output: 'x', columns: 0 })).toEqual(parseTween({}));
  });
});
