import { describe, expect, it } from 'vitest';

import { codePointRange, defaultTextPanelTab, selectedCharacterCount } from './canvasTextRevision';
import { textPreviewOwnsWheel } from './canvasTextWheel';

describe('text revision helpers', () => {
  it('converts textarea UTF-16 offsets to code point offsets', () => {
    const text = '前缀😀甲乙丙后缀';
    const start = text.indexOf('甲');
    expect(start).toBe(4);
    expect(codePointRange(text, { start, end: start + 3 })).toEqual({ start: 3, end: 6 });
    expect(selectedCharacterCount(text, { start: 2, end: 5 })).toBe(2);
    expect(selectedCharacterCount('甲\n乙 丙', { start: 0, end: 5 })).toBe(3);
  });

  it('opens populated text on the content page and empty text on the generate page', () => {
    expect(defaultTextPanelTab('正文')).toBe('content');
    expect(defaultTextPanelTab('  \n')).toBe('generate');
    expect(defaultTextPanelTab(null)).toBe('generate');
  });
});

describe('text preview wheel', () => {
  const overflowing = { scrollHeight: 400, clientHeight: 120 };
  it('scrolls overflowing text under the pointer', () => {
    expect(textPreviewOwnsWheel({ ctrlKey: false, deltaX: 0, deltaY: 40 }, overflowing)).toBe(true);
  });
  it('leaves pinch zoom, horizontal pans and fitting text to the canvas', () => {
    expect(textPreviewOwnsWheel({ ctrlKey: true, deltaX: 0, deltaY: 40 }, overflowing)).toBe(false);
    expect(textPreviewOwnsWheel({ ctrlKey: false, deltaX: 30, deltaY: 4 }, overflowing)).toBe(false);
    expect(textPreviewOwnsWheel({ ctrlKey: false, deltaX: 0, deltaY: 40 }, { scrollHeight: 100, clientHeight: 120 })).toBe(false);
  });
});
