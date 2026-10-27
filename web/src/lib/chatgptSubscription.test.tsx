import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';
import { imageControlCaps } from './imageControlCaps';
import { normalizeImageSizeParams, prepareImageSizeSubmission } from './imageSizeMode';
import { intersectImageCaps } from './modelRoutes';
import { estimateGenerationCostForSubmission } from './generationCost';
import { canvasGenerationModelSupportsMode, canvasUpscaleModelChoices } from '@/pages/canvasEditorModel';
import { editModelChoices } from '@/components/canvas/imageEditGeometry';
import { ModelPickerList } from '@/components/ModelPickerList';

vi.mock('./useModelPickerMetrics', () => ({ useModelPickerMetrics: () => ({ durations: {}, prices: {} }) }));
const key: KeyView = {
  alias: 'chatgpt', provider: 'chatgpt', auth_source: 'codex-cli', base_url: null,
  access_key: '', secret_key: null, capabilities: [], created_at: '', notes: '',
  models: [{ id: 'gpt-image-2', name: 'GPT Image', modality: 'image' }],
};

describe('subscription image capabilities', () => {
  it('does not expose unverified options and clears stale parameters before submitting', () => {
    const caps = imageControlCaps('gpt-image-2', 'chatgpt');
    expect(caps).toMatchObject({ maxCount: 1, maxRefImages: 1, ratios: [], resolutions: [], qualities: null, showAutoSize: false, showCustomSize: false, sizeKind: 'none' });
    const stale = { n: 4, size_mode: 'custom' as const, size: 'bad', ratio: '16:9', quality: 'high' as const, custom_size: 'bad', resolution: '2K', reference_images: ['reference.png'] };
    expect(normalizeImageSizeParams('gpt-image-2', 'chatgpt', null, stale)).toEqual({ n: 1, reference_images: ['reference.png'] });
    expect(prepareImageSizeSubmission('gpt-image-2', 'chatgpt', null, stale)).toEqual({ params: { n: 1, reference_images: ['reference.png'] } });
    expect(intersectImageCaps([imageControlCaps('gpt-image-2', 'openai'), caps])).toMatchObject({ maxCount: 1, maxRefImages: 1, ratios: [], sizeKind: 'none', qualities: null });
  });
  it('allows regular canvas generation without exposing unverified editing tools', () => {
    expect(canvasGenerationModelSupportsMode(key, key.models[0], 'image')).toBe(true);
    expect(editModelChoices([key])).toEqual([]);
    expect(canvasUpscaleModelChoices([key])).toEqual([]);
  });
  it('records zero cost and labels the model as a subscription without a version claim', () => {
    expect(estimateGenerationCostForSubmission(key, 'gpt-image-2', 'image', { n: 1 })).toBe(0);
    render(<ModelPickerList choices={[{ key, model: key.models[0] }]} selected="chatgpt:gpt-image-2" onSelect={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'GPT Image' })).toBeInTheDocument();
    expect(screen.getByText('订阅')).toBeInTheDocument();
    expect(screen.queryByText('GPT Image 2')).not.toBeInTheDocument();
  });
});
