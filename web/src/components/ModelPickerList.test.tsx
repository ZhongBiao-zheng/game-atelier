import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { ModelDeclared } from '@/schema/httpProtocols';
import { ModelPickerList } from './ModelPickerList';

const metrics = vi.hoisted(() => ({ prices: {} as Record<string, number | null> }));
vi.mock('@/lib/useModelPickerMetrics', () => ({ useModelPickerMetrics: () => ({ durations: {}, prices: metrics.prices }) }));

const DECLARED: ModelDeclared = {
  available: true, error: null, name: '接口', kind: 'image', ratios: ['1:1'], resolutions: null,
  durations: null, max_count: 1, reference_images: 0, frames: 0,
};

function key(alias: string, models: KeyView['models']): KeyView {
  return { alias, provider: 'custom', base_url: 'https://api.example.com', access_key: '', secret_key: null,
    capabilities: [], notes: '', created_at: '', models };
}

it('marks custom-interface models with their provider and as unpriced', () => {
  const builtin = key('Tuzi', [{ id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image' }]);
  const custom = key('OpenAI-HK', [{ id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image',
    protocol: 'declarative', declarative_id: 'hp-aaaaaaaaaaaa', declared: DECLARED }]);
  render(<ModelPickerList selected="" onSelect={vi.fn()} choices={[
    { key: builtin, model: builtin.models[0] }, { key: custom, model: custom.models[0] },
  ]} />);
  const options = screen.getAllByRole('option');
  expect(options).toHaveLength(2);
  const marked = options.find(option => option.textContent?.includes('自定义'))!;
  expect(within(marked).getByText('自定义 · OpenAI-HK')).toBeInTheDocument();
  expect(within(marked).getByText('未计价')).toBeInTheDocument();
  const plain = options.find(option => option !== marked)!;
  expect(plain.textContent).not.toContain('自定义');
  expect(plain.textContent).not.toContain('未计价');
});

it('shows audio unit prices per thousand characters or per song', () => {
  const td: KeyView = { ...key('TD', [
    { id: 'minimax-speech-2.8-turbo', name: 'Speech', modality: 'audio', protocol: 'minimax-t2a' },
    { id: 'yc-song-4.0', name: 'Song', modality: 'audio', protocol: 'yinchao-song' },
  ]), provider: 'tokendance' };
  metrics.prices = { 'TD:minimax-speech-2.8-turbo': 0.16, 'TD:yc-song-4.0': 0.22 };
  render(<ModelPickerList selected="" onSelect={vi.fn()} choices={td.models.map(model => ({ key: td, model }))} />);
  expect(within(screen.getByRole('option', { name: 'Speech' })).getByText('0.16¥/千字')).toBeInTheDocument();
  expect(within(screen.getByRole('option', { name: 'Song' })).getByText('0.22¥/首')).toBeInTheDocument();
  metrics.prices = {};
});

it('lists every model a guided key preselected', () => {
  const images = ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6', 'nano-banana-2', 'nano-banana-pro',
    'doubao-seedream-5-0-lite-260128', 'doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-5-261028',
    'doubao-seedream-4-5-251128', 'mj_imagine', 'flux-3-image'];
  const videos = ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628', 'sora-2-pro', 'kling-4.0', 'happyhorse-1.1'];
  const tuzi = key('Tuzi', [
    ...images.map(id => ({ id, name: id, modality: 'image' as const })),
    ...videos.map(id => ({ id, name: id, modality: 'video' as const })),
  ]);
  const onSelect = vi.fn();
  render(<ModelPickerList selected="" sections initialKind="image" onSelect={onSelect} choices={tuzi.models.map(model => ({ key: tuzi, model }))} />);
  const options = screen.getAllByRole('option');
  expect(options).toHaveLength(images.length + videos.length);
  expect(new Set(options.map(option => option.textContent)).size).toBe(options.length);
});
