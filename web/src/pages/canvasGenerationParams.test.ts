import { expect, it } from 'vitest';

import {
  normalizeCanvasAudioParams,
  normalizeCanvasImageParams,
  normalizeCanvasTextParams,
  normalizeCanvasVideoParams,
  supportsCanvasTextGeneration,
} from './canvasEditorModel';

it('preserves an editable image count while Midjourney remains fixed at four', () => {
  expect(normalizeCanvasImageParams('gpt-image-2', 'openai', { n: 3, ratio: '1:1' }).n).toBe(3);
  expect(normalizeCanvasImageParams('midjourney-v7', 'custom', { n: 1, ratio: '1:1' }).n).toBe(4);
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

it('keeps reasoning effort only for the Responses protocol', () => {
  expect(normalizeCanvasTextParams(
    'openai-responses',
    { n: 3, reasoning_effort: 'xhigh', temperature: 0.8, voice: 'alloy', ratio: '16:9' },
  )).toEqual({ n: 3, reasoning_effort: 'xhigh' });
  expect(normalizeCanvasTextParams(
    'openai-chat',
    { n: 2, reasoning_effort: 'high' },
  )).toEqual({ n: 2 });
  expect(supportsCanvasTextGeneration('openai', 'openai-responses')).toBe(true);
  expect(supportsCanvasTextGeneration('custom', 'anthropic:messages')).toBe(false);
});

it('normalizes speech controls and removes foreign modality parameters', () => {
  expect(normalizeCanvasAudioParams(
    'gpt-4o-mini-tts',
    'openai',
    'openai-speech',
    {
      voice: 'marin',
      response_format: 'pcm',
      speed: 9,
      instructions: '  温柔、克制  ',
      n: 4,
      reasoning_effort: 'high',
    },
  )).toEqual({
    voice: 'marin',
    response_format: 'pcm',
    speed: 4,
    instructions: '温柔、克制',
  });
});
