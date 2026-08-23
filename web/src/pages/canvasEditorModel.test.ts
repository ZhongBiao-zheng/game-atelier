import { expect, it } from 'vitest';

import { buildCanvasGenerationRequest } from './canvasEditorModel';
import type { Job } from '@/schema/jobs';
import type { CanvasGenerationNode, CanvasNode } from '@/schema/canvas';

const target: CanvasGenerationNode = {
  id: 'gen-target',
  type: 'generation',
  position: { x: 400, y: 100 },
  data: {
    media_kind: 'image',
    draft: { prompt: '电影感列车', model: 'gpt-image-2', alias: 'main', params: { n: 2 } },
    job_ids: [],
  },
};

it('builds a generation request with visible text and media provenance', () => {
  const sources: CanvasNode[] = [
    { id: 'text-1', type: 'text', position: { x: 0, y: 0 }, data: { title: '场景', text: '雨夜' } },
    {
      id: 'resource-1',
      type: 'resource',
      position: { x: 0, y: 100 },
      data: { media_kind: 'image', path: 'canvases/c1/uploads/ref.png', filename: 'ref.png' },
    },
  ];

  const result = buildCanvasGenerationRequest(target, sources, new Map());

  expect(result.body.prompt).toBe('电影感列车\n\n参考文本「场景」：\n雨夜');
  expect(result.body.params).toMatchObject({ n: 2, reference_images: ['canvases/c1/uploads/ref.png'] });
  expect(result.sourceNodeIds).toEqual(['text-1', 'resource-1']);
});

it('uses the selected output of an upstream generation node', () => {
  const upstream: CanvasGenerationNode = {
    ...target,
    id: 'gen-upstream',
    data: { ...target.data, job_ids: ['job-1'], active_job_id: 'job-1', selected_output_index: 1 },
  };
  const job = {
    job_id: 'job-1',
    kind: 'image',
    output_paths: ['first.png', 'second.png'],
    status: 'done',
  } as Job;

  const result = buildCanvasGenerationRequest(target, [upstream], new Map([['job-1', job]]));

  expect(result.body.params.reference_images).toEqual(['second.png']);
});

it('does not record provenance for sources that were not used', () => {
  const emptyText: CanvasNode = {
    id: 'empty-text', type: 'text', position: { x: 0, y: 0 }, data: { text: '' },
  };
  const pendingGeneration: CanvasGenerationNode = {
    ...target,
    id: 'pending-generation',
    data: { ...target.data, job_ids: ['pending-job'], active_job_id: 'pending-job' },
  };
  const pendingJob: Job = {
    job_id: 'pending-job', character_id: 'main', prompt: 'pending',
    submitted_at: '2026-08-23T00:00:00Z', model: 'gpt-image-2', params: {},
    status: 'pending', output_paths: [], error: null,
  };

  const result = buildCanvasGenerationRequest(
    target,
    [emptyText, pendingGeneration],
    new Map([['pending-job', pendingJob]]),
  );

  expect(result.sourceNodeIds).toEqual([]);
});
