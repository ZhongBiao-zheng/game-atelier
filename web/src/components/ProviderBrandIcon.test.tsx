import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderBrandIcon } from './ProviderBrandIcon';
import { providerPresetId } from '@/pages/settings/providerPresets';

describe('provider identity and local branding', () => {
  it.each([
    ['custom', 'https://api.tu-zi.com/v1', 'tuzi'],
    ['custom', 'https://tu-zi.com', 'tuzi'],
    ['custom', 'https://www.openai-hk.com/v1', 'openai-hk'],
    ['custom', 'https://openai-hk.com.example.org', 'custom'],
    ['custom', 'not a url', 'custom'],
    ['openai', 'https://api.tu-zi.com', 'openai'],
    ['seedream', null, 'seedream'],
  ])('resolves %s at %s to %s', (provider, base_url, id) => {
    expect(providerPresetId({ provider, base_url })).toBe(id);
  });

  it('uses packaged raster images at the requested size', () => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://api.tu-zi.com' }} size={14} />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).not.toMatch(/^https?:/);
    expect(image).toHaveAttribute('width', '14');
    expect(image).toHaveAttribute('height', '14');
  });

  it('uses currentColor SVGs and falls back to the building icon for unknown providers', () => {
    const { container, rerender } = render(<ProviderBrandIcon provider={{ provider: 'openrouter' }} size={14} />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
    rerender(<ProviderBrandIcon provider={{ provider: 'unknown' }} />);
    expect(container.querySelector('svg')).toHaveClass('lucide-building-2');
  });
});
