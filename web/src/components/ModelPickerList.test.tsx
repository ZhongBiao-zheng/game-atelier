import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { ModelDeclared } from '@/schema/httpProtocols';
import { ModelPickerList } from './ModelPickerList';

vi.mock('@/lib/useModelPickerMetrics', () => ({ useModelPickerMetrics: () => ({ durations: {}, prices: {} }) }));

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
