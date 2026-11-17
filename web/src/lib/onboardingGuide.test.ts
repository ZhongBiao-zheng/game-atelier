import { expect, it } from 'vitest';
import type { KeyView } from '@/api/keys';
import { hasUsableModel, RECOMMENDED_PROVIDERS } from './onboardingGuide';
import { PROVIDER_PRESETS } from '@/pages/settings/providerPresets';

function key(overrides: Partial<KeyView>): KeyView {
  return { alias: 'k', provider: 'custom', base_url: null, access_key: '****', secret_key: null,
    capabilities: [], notes: '', created_at: '', models: [], ...overrides };
}

it('counts only enabled providers that carry an image or video model', () => {
  expect(hasUsableModel([])).toBe(false);
  expect(hasUsableModel([key({ models: [{ id: 'gpt-5', name: 'GPT 5', modality: 'text' }] })])).toBe(false);
  expect(hasUsableModel([key({ models: [{ id: 'tts-1', name: 'TTS', modality: 'audio' }] })])).toBe(false);
  expect(hasUsableModel([key({ provider: 'comfyui', models: [] })])).toBe(false);
  expect(hasUsableModel([key({ enabled: false, models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' }] })])).toBe(false);
  expect(hasUsableModel([key({ models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' }] })])).toBe(true);
  expect(hasUsableModel([key({ models: [{ id: 'seedance-2.0', name: 'Seedance', modality: 'video' }] })])).toBe(true);
});

it('lists Tuzi then TokenDance, each pointing at a preset with its own https steps', () => {
  expect(RECOMMENDED_PROVIDERS.map(item => item.presetId)).toEqual(['tuzi', 'tokendance']);
  for (const vendor of RECOMMENDED_PROVIDERS) {
    expect(PROVIDER_PRESETS.some(preset => preset.id === vendor.presetId)).toBe(true);
    expect(vendor.steps.map(step => step.id)).toEqual(['signup', 'topup', 'key_page']);
    for (const step of vendor.steps) expect(step.url).toMatch(/^https:\/\//);
  }
  expect(RECOMMENDED_PROVIDERS[0].steps.find(step => step.id === 'key_page')?.hint).toContain('default');
  expect(RECOMMENDED_PROVIDERS[1].steps.find(step => step.id === 'signup')?.hint).toContain('观猹');
});
