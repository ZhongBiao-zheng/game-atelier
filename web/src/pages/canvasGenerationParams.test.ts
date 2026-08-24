import { expect, it } from 'vitest';

import { normalizeCanvasImageParams, normalizeCanvasVideoParams } from './canvasEditorModel';

it('preserves an editable image count while Midjourney remains fixed at four', () => {
  expect(normalizeCanvasImageParams('gpt-image-2', 'openai', { n: 3, ratio: '1:1' }).n).toBe(3);
  expect(normalizeCanvasImageParams('midjourney-v7', 'custom', { n: 1, ratio: '1:1' }).n).toBe(4);
});

it('keeps transparent background only for direct gpt-image models', () => {
  expect(normalizeCanvasImageParams(
    'gpt-image-2',
    'openai',
    { n: 3, ratio: '1:1', background: 'transparent' },
  )).toMatchObject({ n: 3, background: 'transparent' });

  expect(normalizeCanvasImageParams(
    'openai/gpt-image-1',
    'openrouter',
    { n: 3, ratio: '1:1', background: 'transparent' },
  )).not.toHaveProperty('background');

  expect(normalizeCanvasImageParams(
    'gpt-image-2',
    'custom',
    { n: 3, ratio: '1:1', background: 'transparent' },
    'ark',
  )).not.toHaveProperty('background');
});

it('keeps watermark only for video families that expose the setting', () => {
  expect(normalizeCanvasVideoParams(
    'seedance-2.0',
    'seedance',
    { watermark: true },
  )).toMatchObject({ watermark: true });
  expect(normalizeCanvasVideoParams(
    'kling-v2',
    'kling',
    { watermark: true },
  )).not.toHaveProperty('watermark');
});
