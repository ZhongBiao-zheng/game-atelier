import { describe, expect, it } from 'vitest';

import {
  assetMediaContent,
  renderCreationPrompt,
  type CreationAsset,
  type CreationMediaAssetContent,
  type CreationPromptSegment,
} from './creationAssets';

const segments: CreationPromptSegment[] = [
  { kind: 'text', text: '一只' },
  { kind: 'variable', name: '主体', default_value: '白色三头犬' },
  { kind: 'text', text: '站在' },
  { kind: 'variable', name: '场景', default_value: '火山口' },
  { kind: 'text', text: '中。' },
];

describe('renderCreationPrompt', () => {
  it('joins variable values without injecting whitespace', () => {
    expect(renderCreationPrompt(segments)).toBe('一只白色三头犬站在火山口中。');
    expect(renderCreationPrompt(segments, { 主体: '机械犬', 场景: '月面' }))
      .toBe('一只机械犬站在月面中。');
  });

  it('uses the default content when a variable is blank', () => {
    expect(renderCreationPrompt(segments, { 主体: '   ' }))
      .toBe('一只白色三头犬站在火山口中。');
  });
});

describe('assetMediaContent', () => {
  const media: CreationMediaAssetContent = {
    kind: 'media',
    path: 'creation-assets/blobs/a.png',
    mime_type: 'image/png',
    bytes: 3,
    sha256: 'a'.repeat(64),
    filename: 'a.png',
  };
  const base = {
    asset_id: 'asset-1',
    title: '标题',
    tags: [],
    created_at: '2026-09-23T00:00:00Z',
    updated_at: '2026-09-23T00:00:00Z',
    last_used_at: null,
    project_ids: [],
  };

  it('returns the media content of a media asset', () => {
    expect(assetMediaContent({ ...base, kind: 'media', content: media })).toBe(media);
  });

  it('returns the finished media of a generation asset', () => {
    const asset: CreationAsset = {
      ...base,
      kind: 'generation',
      content: {
        kind: 'generation',
        media,
        snapshot: {
          mode: 'image',
          model: 'gpt-image-2',
          provider: null,
          alias: null,
          final_prompt: '一只白犬',
          draft_prompt: null,
          params: {},
          inputs: [],
          cost_cny: null,
          cost_basis: null,
          submitted_at: '2026-09-23T00:00:00Z',
        },
      },
    };
    expect(assetMediaContent(asset)).toBe(media);
  });

  it('returns null for a prompt asset', () => {
    expect(assetMediaContent({ ...base, kind: 'prompt', content: { kind: 'prompt', segments } })).toBeNull();
  });
});
