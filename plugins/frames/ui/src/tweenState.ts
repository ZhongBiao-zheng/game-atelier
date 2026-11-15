/** 补间节点的数据（payload，版本 1）与帧序列的取法。读的时候逐项校验，坏值回落到默认值。 */
import type { PluginInput } from '../../../sdk';

export type TweenMethod = 'flow' | 'crossfade';
export type TweenOutput = 'all' | 'new';

export interface TweenState {
  method: TweenMethod;
  /** 每两帧之间补几帧。 */
  between: number;
  output: TweenOutput;
  /** 两张单独的图时交换首尾。 */
  swap: boolean;
  sheet: boolean;
  columns: number;
  frame_data: boolean;
}

export const MAX_BETWEEN = 15;
export const MAX_OUTPUT = 65;
export const DEFAULT_TWEEN: TweenState = {
  method: 'flow', between: 3, output: 'all', swap: false, sheet: false, columns: 8, frame_data: true,
};

const intIn = (value: unknown, min: number, max: number, fallback: number) => (
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback);

export function parseTween(payload: unknown): TweenState {
  const raw = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return {
    method: raw.method === 'crossfade' ? 'crossfade' : 'flow',
    between: intIn(raw.between, 1, MAX_BETWEEN, DEFAULT_TWEEN.between),
    output: raw.output === 'new' ? 'new' : 'all',
    swap: raw.swap === true,
    sheet: raw.sheet === true,
    columns: intIn(raw.columns, 1, MAX_OUTPUT, DEFAULT_TWEEN.columns),
    frame_data: raw.frame_data !== false,
  };
}

/**
 * 要补间的帧序列：连了结果组就用第一组（按组内顺序）；否则用两张单独的图，`swap` 交换首尾。
 * 不足两帧时 kind 为 'none'。
 */
export function tweenSequence(inputs: readonly PluginInput[], swap: boolean): {
  kind: 'group' | 'pair' | 'none'; items: PluginInput[];
} {
  const images = inputs.filter(input => input.kind === 'image');
  const group = images.find(input => input.group)?.group;
  if (group) {
    const items = images.filter(input => input.group === group);
    return items.length >= 2 ? { kind: 'group', items } : { kind: 'none', items };
  }
  if (images.length < 2) return { kind: 'none', items: images };
  const pair = images.slice(0, 2);
  return { kind: 'pair', items: swap ? [pair[1], pair[0]] : pair };
}

export function outputCount(frames: number, state: Pick<TweenState, 'between' | 'output'>): number {
  const added = Math.max(0, frames - 1) * state.between;
  return state.output === 'all' ? frames + added : added;
}

export function methodLabel(method: TweenMethod): string {
  return method === 'flow' ? '光流' : '交叉淡化';
}
