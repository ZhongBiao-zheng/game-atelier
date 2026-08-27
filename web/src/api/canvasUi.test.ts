import { afterEach, expect, it, vi } from 'vitest';

import type { CanvasGenerationDefaults, CanvasImageToolbarPreferences } from '@/schema/canvas';
import { getCanvasUiPreferences, saveCanvasUiPreferences } from './canvasUi';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('reads and writes the complete revisioned Canvas UI preference document', async () => {
  const imageToolbar: CanvasImageToolbarPreferences = {
    tool_ids: ['info', 'download'],
    show_labels: true,
  };
  const generationDefaults: CanvasGenerationDefaults = {
    text: { selection: null, params: {} },
    image: {
      selection: { alias: 'main', model: 'gpt-image-1' },
      params: { n: 2, ratio: '16:9' },
    },
    video: { selection: null, params: {} },
    audio: { selection: null, params: {} },
  };
  const response = {
    schema_version: 2,
    revision: 5,
    image_toolbar: imageToolbar,
    generation_defaults: generationDefaults,
    updated_at: '2026-08-25T00:00:00Z',
  };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await getCanvasUiPreferences();
  await saveCanvasUiPreferences(4, imageToolbar, generationDefaults);

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/canvas/ui-preferences');
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/canvas/ui-preferences',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        expected_revision: 4,
        image_toolbar: imageToolbar,
        generation_defaults: generationDefaults,
      }),
    }),
  );
});
