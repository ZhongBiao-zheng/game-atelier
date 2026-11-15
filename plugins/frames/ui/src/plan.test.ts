import { describe, expect, it } from 'vitest';

import cases from '../../tests/plan_cases.json';
import { outputSize, planFrames, type PlanParams } from './plan';

describe('抽帧计划与服务端一致', () => {
  it.each(cases.plan)('$name', ({ frame_count: frameCount, fps, params, ...rest }) => {
    const run = () => planFrames(frameCount, fps, params as PlanParams);
    if ('error' in rest) expect(run).toThrow(rest.error as string);
    else expect(run()).toEqual((rest as { expect: number[] }).expect);
  });
});

describe('输出尺寸与服务端一致', () => {
  it.each(cases.size)('$name', ({ width, height, long_edge: longEdge, expect: want }) => {
    expect(outputSize(width, height, longEdge)).toEqual(want);
  });
});
