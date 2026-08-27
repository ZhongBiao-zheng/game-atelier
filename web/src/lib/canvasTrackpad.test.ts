import { describe, expect, it } from 'vitest';

import { shouldPreventCanvasHistoryNavigation } from './canvasTrackpad';

describe('shouldPreventCanvasHistoryNavigation', () => {
  it('claims horizontal two-finger movement before the browser can navigate history', () => {
    expect(shouldPreventCanvasHistoryNavigation({ deltaX: 86, deltaY: 8, ctrlKey: false })).toBe(true);
    expect(shouldPreventCanvasHistoryNavigation({ deltaX: -64, deltaY: 3, ctrlKey: false })).toBe(true);
  });

  it('leaves vertical scrolling and pinch zoom to their existing handlers', () => {
    expect(shouldPreventCanvasHistoryNavigation({ deltaX: 5, deltaY: 60, ctrlKey: false })).toBe(false);
    expect(shouldPreventCanvasHistoryNavigation({ deltaX: 0, deltaY: -8, ctrlKey: true })).toBe(false);
  });
});
