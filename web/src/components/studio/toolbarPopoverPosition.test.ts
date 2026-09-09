import { describe, expect, it } from 'vitest';
import { toolbarPopoverPosition } from './toolbarPopoverPosition';

const viewport = { left: 0, top: 0, right: 800, bottom: 600 };
const anchor = { left: 300, right: 400, top: 300, bottom: 340 };

describe('toolbar popover viewport bounds', () => {
  it('keeps the preferred side when the menu fits', () => {
    expect(toolbarPopoverPosition(anchor, { width: 200, height: 100 }, viewport, 'up', 'start'))
      .toMatchObject({ direction: 'up', left: 300, top: 188, maxHeight: 276 });
    expect(toolbarPopoverPosition(anchor, { width: 200, height: 100 }, viewport, 'down', 'end'))
      .toMatchObject({ direction: 'down', left: 200, top: 352, maxHeight: 236 });
  });

  it('flips when the preferred side cannot hold the menu', () => {
    expect(toolbarPopoverPosition({ ...anchor, top: 80, bottom: 120 }, { width: 320, height: 200 }, viewport, 'up', 'start'))
      .toMatchObject({ direction: 'down', top: 132, maxHeight: 456 });
    expect(toolbarPopoverPosition({ ...anchor, top: 500, bottom: 540 }, { width: 320, height: 200 }, viewport, 'down', 'start'))
      .toMatchObject({ direction: 'up', top: 288, maxHeight: 476 });
  });

  it('uses the larger side and caps tall menus, with preferred direction breaking ties', () => {
    expect(toolbarPopoverPosition(anchor, { width: 320, height: 900 }, viewport, 'down', 'start'))
      .toMatchObject({ direction: 'up', top: 12, height: 276, maxHeight: 276 });
    expect(toolbarPopoverPosition({ ...anchor, top: 280, bottom: 320 }, { width: 320, height: 900 }, viewport, 'down', 'start'))
      .toMatchObject({ direction: 'down', top: 332, height: 256, maxHeight: 256 });
  });

  it('caps width and clamps either alignment to the safe viewport', () => {
    const narrow = { left: 0, top: 0, right: 280, bottom: 500 };
    for (const align of ['start', 'end'] as const) {
      expect(toolbarPopoverPosition(anchor, { width: 320, height: 100 }, narrow, 'up', align))
        .toMatchObject({ left: 12, maxWidth: 256 });
    }
    expect(toolbarPopoverPosition({ ...anchor, left: 750, right: 790 }, { width: 320, height: 100 }, viewport, 'up', 'start').left)
      .toBe(468);
    expect(toolbarPopoverPosition({ ...anchor, left: 10, right: 50 }, { width: 320, height: 100 }, viewport, 'up', 'end').left)
      .toBe(12);
  });

  it('uses the visual viewport offset and visible height, not the hidden keyboard area', () => {
    const visible = { left: 40, top: 100, right: 415, bottom: 400 };
    const result = toolbarPopoverPosition(anchor, { width: 320, height: 500 }, visible, 'down', 'start');
    expect(result).toMatchObject({ direction: 'up', left: 83, top: 112, maxHeight: 176, maxWidth: 351 });
  });

  it.each([-500, 900])('keeps a menu inside the viewport when its anchor moves outside (%i)', top => {
    const result = toolbarPopoverPosition({ ...anchor, top, bottom: top + 40 }, { width: 320, height: 800 }, viewport, 'up', 'start');
    expect(result.top).toBeGreaterThanOrEqual(12);
    expect(result.top + result.height).toBeLessThanOrEqual(588);
  });
});
