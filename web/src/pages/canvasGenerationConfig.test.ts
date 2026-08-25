import { expect, it } from 'vitest';

import type { KeyView } from '@/api/keys';
import type { CanvasDocument, CanvasGenerationDraft } from '@/schema/canvas';
import {
  createCanvasGenerationDraft,
  createConnectedCanvasConfig,
  canvasGenerationPreferenceForModel,
  firstCanvasGenerationModel,
  switchCanvasGenerationDraft,
} from './canvasEditorModel';

const keys: KeyView[] = [
  {
    alias: 'image-key', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image', protocol: 'openai' }],
  },
  {
    alias: 'video-key', provider: 'seedance', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'seedance-2.0', name: 'Seedance 2.0', modality: 'video', protocol: 'seedance' }],
  },
];

function documentWithText(text = '雨夜列车分镜'): CanvasDocument {
  return {
    schema_version: 2,
    project_id: 'canvas-test',
    revision: 4,
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { background: 'dots', show_image_info: true, show_minimap: true },
    nodes: [{
      id: 'text-source', title: '分镜', type: 'text', position: { x: 24, y: 48 }, z_index: 0,
      data: {
        current_version_id: 'version-text', generation_draft: null, active_run_id: null,
        display: { scale: 'sm' },
      },
    }],
    connections: [],
    content_versions: {
      'version-text': {
        version_id: 'version-text', kind: 'text', text,
        created_at: '2026-08-25T00:00:00Z', sha256: 'a'.repeat(64),
        origin: { kind: 'user_edit' },
      },
    },
    updated_at: '2026-08-25T00:00:00Z',
  };
}

it('creates a capability-honest config draft and preserves references while switching modes', () => {
  const image = createCanvasGenerationDraft(keys, 'image', {
    now: '2026-08-25T01:00:00Z',
  });
  expect(image).toMatchObject({
    mode: 'image', alias: 'image-key', model: 'gpt-image-2',
    input_policy: 'mentions_only', params: { n: 1, ratio: '1:1' },
  });

  const current: CanvasGenerationDraft = {
    ...image,
    prompt: '沿用 @[node:text-source] 的节奏',
  };
  const video = switchCanvasGenerationDraft(
    keys,
    current,
    'video',
    { now: '2026-08-25T02:00:00Z' },
  );
  expect(video).toMatchObject({
    mode: 'video', alias: 'video-key', model: 'seedance-2.0',
    prompt: current.prompt, input_policy: 'mentions_only',
    params: { duration: 5, resolution: '720p', ratio: '16:9' },
    updated_at: '2026-08-25T02:00:00Z',
  });
});

it('creates one connected image config to the right of a non-empty text node', () => {
  const draft = createCanvasGenerationDraft(keys, 'image', {
    now: '2026-08-25T01:00:00Z',
  });
  const next = createConnectedCanvasConfig(documentWithText(), 'text-source', draft, {
    nodeId: 'config-image',
    connectionId: 'connection-text-image',
  });

  expect(next?.nodes.at(-1)).toMatchObject({
    id: 'config-image', title: '图片生成', type: 'config',
    position: { x: 376, y: 48 },
    data: {
      draft: {
        mode: 'image', prompt: '@[node:text-source]', input_policy: 'mentions_only',
      },
    },
  });
  expect(next?.connections).toContainEqual({
    id: 'connection-text-image', role: 'input',
    source_node_id: 'text-source', target_node_id: 'config-image',
  });
  expect(next?.revision).toBe(4);
});

it('refuses to create a connected config from empty text', () => {
  const draft = createCanvasGenerationDraft(keys, 'image');
  expect(createConnectedCanvasConfig(documentWithText('  '), 'text-source', draft, {
    nodeId: 'config-image',
    connectionId: 'connection-text-image',
  })).toBeNull();
});

it('skips models that the Canvas Runner cannot route', () => {
  const mixedKeys: KeyView[] = [
    {
      ...keys[0], alias: 'unsupported-images', provider: 'nano_banana',
      models: [{ id: 'nano-banana-pro', name: 'Nano Banana', modality: 'image', protocol: null }],
    },
    {
      ...keys[0], alias: 'wrong-image-protocol',
      models: [{ id: 'gpt-image-2', name: 'Wrong image protocol', modality: 'image', protocol: 'openai-image' }],
    },
    keys[0],
    {
      ...keys[1], alias: 'unsupported-video-protocol', provider: 'custom',
      models: [{ id: 'custom-video', name: 'Custom video', modality: 'video', protocol: 'openai' }],
    },
    {
      ...keys[1], alias: 'unsupported-video-edit', provider: 'tokendance',
      models: [{ id: 'happyhorse-video-edit', name: 'HappyHorse edit', modality: 'video', protocol: 'dashscope' }],
    },
    keys[1],
  ];

  expect(firstCanvasGenerationModel(mixedKeys, 'image')).toMatchObject({
    key: { alias: 'image-key' }, model: { id: 'gpt-image-2' },
  });
  expect(firstCanvasGenerationModel(mixedKeys, 'video')).toMatchObject({
    key: { alias: 'video-key' }, model: { id: 'seedance-2.0' },
  });
});

it('keeps model and capability params empty when no routable model exists', () => {
  const unavailable: KeyView[] = [{
    ...keys[0], alias: 'unsupported-images', provider: 'nano_banana',
    models: [{ id: 'nano-banana-pro', name: 'Nano Banana', modality: 'image', protocol: null }],
  }];

  expect(createCanvasGenerationDraft(unavailable, 'image', {
    now: '2026-08-25T03:00:00Z',
  })).toEqual({
    mode: 'image', prompt: '', input_policy: 'mentions_only', model: '', alias: null,
    params: {}, updated_at: '2026-08-25T03:00:00Z',
  });
});

it('uses a valid saved model preference and normalizes its default params', () => {
  const alternate: KeyView = {
    ...keys[0],
    alias: 'image-alt',
    models: [{
      id: 'gpt-image-1', name: 'GPT Image 1', modality: 'image', protocol: 'openai',
    }],
  };
  const preference = canvasGenerationPreferenceForModel(
    alternate,
    alternate.models[0],
    'image',
    { n: 3, ratio: '16:9', quality: 'high' },
  );

  expect(preference).not.toBeNull();
  expect(createCanvasGenerationDraft([...keys, alternate], 'image', {
    preference: preference!,
    now: '2026-08-25T04:00:00Z',
  })).toMatchObject({
    alias: 'image-alt',
    model: 'gpt-image-1',
    params: { n: 3, ratio: '16:9', quality: 'high' },
  });
});

it('applies saved default params while the model remains automatic', () => {
  expect(createCanvasGenerationDraft(keys, 'image', {
    preference: {
      selection: null,
      params: { n: 3, ratio: '16:9', quality: 'high' },
    },
    now: '2026-08-25T04:30:00Z',
  })).toMatchObject({
    alias: 'image-key',
    model: 'gpt-image-2',
    params: { n: 3, ratio: '16:9', quality: 'high' },
  });
});

it('falls back without leaking params from a stale model preference', () => {
  const stale = {
    selection: { alias: 'removed-key', model: 'removed-model' },
    params: { n: 4, ratio: '9:16', quality: 'high' },
  };

  expect(createCanvasGenerationDraft(keys, 'image', {
    preference: stale,
    now: '2026-08-25T05:00:00Z',
  })).toMatchObject({
    alias: 'image-key',
    model: 'gpt-image-2',
    params: { n: 1, ratio: '1:1' },
  });
});
