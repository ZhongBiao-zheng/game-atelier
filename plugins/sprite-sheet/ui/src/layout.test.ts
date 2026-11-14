import { describe, expect, it } from 'vitest';

import cases from '../../tests/layout_cases.json';
import { anchorPoint, contentBox, layoutFrames, placements } from './layout';
import { gridFrames, moveFrame, nudgeFrame, parseState } from './sheetState';
import type { Align } from './sheetState';

describe('排布算法与服务端一致', () => {
  it.each(cases)('$name', ({ sizes, offsets, align, anchor, expect: want }) => {
    const result = placements(sizes as Array<[number, number]>, offsets as Array<[number, number]>, align as Align);
    expect([result.cellW, result.cellH]).toEqual(want.cell);
    expect(result.positions.map(position => [...position])).toEqual(want.positions);
    expect(anchorPoint(result.cellW, result.cellH, { x: anchor[0], y: anchor[1] })).toEqual(want.anchor);
  });
});

describe('裁透明边', () => {
  const pixels = (width: number, height: number, opaque: Array<[number, number]>, alpha = 255) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = alpha;
    return data;
  };
  it('找到不透明内容的包围盒', () => {
    expect(contentBox(pixels(6, 5, [[1, 2], [4, 3]]), 6, 5)).toEqual({ x: 1, y: 2, w: 4, h: 2 });
  });
  it('全透明与很淡的像素都算空', () => {
    expect(contentBox(pixels(4, 4, []), 4, 4)).toBeNull();
    expect(contentBox(pixels(4, 4, [[1, 1]], 8), 4, 4)).toBeNull();
  });
  it('裁边后按内容排，关掉裁边就按原帧排', () => {
    const frames = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10, ox: 1, oy: 0 }];
    const boxes = [{ x: 3, y: 0, w: 4, h: 10 }, { x: 0, y: 6, w: 10, h: 4 }];
    const trimmed = layoutFrames(frames, frame => boxes[frame.x / 10], { align: 'bottom-center', trim: true });
    expect([trimmed.cellW, trimmed.cellH]).toEqual([10, 10]);
    expect(trimmed.items.map(item => [item.source.x, item.x, item.y])).toEqual([[3, 3, 0], [10, 1, 6]]);
    const whole = layoutFrames(frames, () => null, { align: 'top-left', trim: false });
    expect(whole.items.map(item => [item.source.w, item.x])).toEqual([[10, 0], [10, 1]]);
  });
  it('全透明的帧当成 1×1（与服务端一致）', () => {
    const result = layoutFrames([{ x: 5, y: 5, w: 4, h: 4 }], () => null, { align: 'top-left', trim: true });
    expect(result.items[0].source).toEqual({ x: 5, y: 5, w: 1, h: 1 });
  });
});

describe('帧列表操作', () => {
  const frames = [0, 1, 2, 3].map(x => ({ x, y: 0, w: 1, h: 1 }));
  it('拖动重排', () => {
    expect(moveFrame(frames, 0, 2).map(frame => frame.x)).toEqual([1, 2, 0, 3]);
    expect(moveFrame(frames, 3, 0).map(frame => frame.x)).toEqual([3, 0, 1, 2]);
  });
  it('微调偏移有上限，只动选中的那一帧', () => {
    const moved = nudgeFrame(nudgeFrame(frames, 1, 10, -1), 1, 1000, 0);
    expect(moved[1]).toMatchObject({ ox: 512, oy: -1 });
    expect(moved[0]).toBe(frames[0]);
  });
});

describe('节点数据的解析', () => {
  it('缺字段或坏数据回落到默认值', () => {
    const state = parseState({ frames: [{ x: 0, y: 0, w: 4, h: 4, ox: 9999 }, { x: 'a' }, null], anchor: { x: 3 }, trim: 'yes' });
    expect(state.frames).toEqual([{ x: 0, y: 0, w: 4, h: 4, ox: 512, oy: 0 }]);
    expect(state.anchor).toEqual({ x: 1, y: 1 });
    expect(state.trim).toBe(true);
    expect(parseState(null).frames).toEqual([]);
  });
  it('手动网格与服务端 grid_frames 一致', () => {
    expect(gridFrames(110, 50, { columns: 2, rows: 1, margin: 5, spacing: 10 }))
      .toEqual([{ x: 5, y: 5, w: 45, h: 40 }, { x: 60, y: 5, w: 45, h: 40 }]);
    expect(gridFrames(100, 50, { columns: 3, rows: 2, margin: 0, spacing: 0 })[5]).toEqual({ x: 66, y: 25, w: 33, h: 25 });
    expect(gridFrames(10, 10, { columns: 40, rows: 1, margin: 0, spacing: 0 })).toEqual([]);
  });
});
