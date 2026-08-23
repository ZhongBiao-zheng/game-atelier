import { expect, it } from 'vitest';

import {
  buildCanvasGenerationRequest,
  normalizeCanvasImageParams,
} from './canvasEditorModel';
import type { CanvasGenerationNode } from '@/schema/canvas';

const target: CanvasGenerationNode = {
  id: 'gen-target',
  type: 'generation',
  position: { x: 400, y: 100 },
  data: {
    media_kind: 'image',
    draft: {
      prompt: '电影感列车',
      model: 'gpt-image-2',
      alias: 'main',
      params: {
        n: 2,
        reference_images: ['legacy.png'],
        reference_videos: ['legacy.mp4'],
        reference_audios: ['legacy.wav'],
      },
    },
    job_ids: [],
  },
};

it('builds a standalone generation request without legacy references', () => {
  const result = buildCanvasGenerationRequest(target, 'openai');

  expect(result.prompt).toBe('电影感列车');
  expect(result.params).toEqual({ n: 2, ratio: '1:1', quality: 'low', size: '2048x2048' });
  expect(result).toMatchObject({ model: 'gpt-image-2', alias: 'main', kind: 'image' });
});

it('normalizes model-specific image parameters when switching models', () => {
  const params = normalizeCanvasImageParams(
    'gpt-image-2',
    'openai',
    { n: 2, ratio: '21:9', resolution: '4K', quality: 'invalid' },
  );

  expect(params).toEqual({ n: 2, ratio: '21:9', quality: 'low', size: '2048x880' });
});

it('locks Midjourney jobs to the four paid outputs from one task', () => {
  const params = normalizeCanvasImageParams(
    'midjourney-v7',
    'custom',
    { n: 1, ratio: '16:9', resolution: '4K', quality: 'high' },
  );

  expect(params).toEqual({ n: 4, ratio: '16:9' });
});
