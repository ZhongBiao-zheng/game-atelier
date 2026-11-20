import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderBrandIcon } from './ProviderBrandIcon';
import { PROVIDER_BRANDS, brandOfIcon } from './providerBrands';
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

  it.each([
    { provider: 'custom', base_url: 'https://api.tu-zi.com' },
    { provider: 'custom', base_url: 'https://api.openai-hk.com' },
    { provider: 'evolink' },
    { provider: 'tokendance' },
  ])('uses packaged monochrome masks at the requested size for $provider $base_url', provider => {
    const { container } = render(<ProviderBrandIcon provider={provider} size="sm" />);
    const mask = container.querySelector('span')!;
    expect(container.querySelector('img')).toBeNull();
    expect(mask).toHaveClass('bg-current');
    expect(mask.style.maskImage).toMatch(/^url\("(?!https?:)/);
    expect(mask.style.width).toBe('14px');
    expect(mask.style.height).toBe('14px');
  });

  it('uses currentColor SVGs and falls back to the building icon for unknown providers', () => {
    const { container, rerender } = render(<ProviderBrandIcon provider={{ provider: 'openrouter' }} size="sm" />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
    rerender(<ProviderBrandIcon provider={{ provider: 'unknown' }} />);
    expect(container.querySelector('svg')).toHaveAttribute('data-icon', 'provider');
  });
});

 it('智能路由使用 Split 图标，不落到普通厂商图标', () => {
  const { container } = render(<ProviderBrandIcon provider={{ provider: 'auto' }} />);
  expect(container.querySelector('[data-icon="route"]')).toBeInTheDocument();
  expect(container.querySelector('[data-icon="provider"]')).not.toBeInTheDocument();
});

// I1：用户选的内置品牌优先，其次预置 / 域名规则，再其次名称首字母，最后通用图标。
describe('自定义图标与首字母兜底', () => {
  it('brand: 优先于预置规则', () => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://api.tu-zi.com', icon: 'brand:deepseek' }} />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
    expect(container.querySelector('.bg-current')).toBeNull();
  });

  it('认不出的 brand: 退回默认规则', () => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://api.tu-zi.com', icon: 'brand:nope' }} />);
    expect(container.querySelector('.bg-current')).not.toBeNull();
  });

  it.each([
    ['relay', 'R'], ['  my relay', 'M'], ['兔子中转', '兔'], ['ä-relay', 'Ä'],
  ])('没有预置也没有图标时显示名称首字母：%s → %s', (alias, letter) => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://relay.example', alias }} size="sm" />);
    const initial = container.querySelector('[data-icon="initial"]')!;
    expect(initial).toHaveTextContent(letter);
    expect((initial as HTMLElement).style.width).toBe('14px');
    expect(container.querySelector('[data-icon="provider"]')).toBeNull();
  });

  it('预置供应商不显示首字母', () => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://api.siliconflow.cn/v1', alias: 'sf' }} />);
    expect(container.querySelector('[data-icon="initial"]')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });

  it('品牌清单里每个 id 都能画出来', () => {
    for (const { id } of PROVIDER_BRANDS) {
      const { container, unmount } = render(<ProviderBrandIcon provider={{ provider: 'custom', icon: `brand:${id}` }} />);
      expect(container.querySelector('svg path'), id).not.toBeNull();
      expect(container.querySelector('[data-icon="model"]'), id).toBeNull();
      unmount();
    }
    expect(new Set(PROVIDER_BRANDS.map(brand => brand.id)).size).toBe(PROVIDER_BRANDS.length);
  });

  it('brandOfIcon 只认 brand: 前缀与清单里的 id', () => {
    expect(brandOfIcon('brand:gemini')).toBe('gemini');
    expect(brandOfIcon('file:' + 'a'.repeat(64))).toBeNull();
    expect(brandOfIcon('gemini')).toBeNull();
    expect(brandOfIcon(null)).toBeNull();
  });
});

describe('上传的图标', () => {
  const sha = 'b'.repeat(64);

  it('file: 显示图片，按原色（不走遮罩）', () => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://api.tu-zi.com', icon: `file:${sha}` }} size="sm" />);
    const image = container.querySelector('img')!;
    expect(image).toHaveAttribute('src', `/api/provider-icons/${sha}`);
    expect(image.style.width).toBe('14px');
    expect(container.querySelector('.bg-current')).toBeNull();
  });

  it('图片读不到（文件不在）时退回默认规则，不报错', () => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://relay.example', alias: 'relay', icon: `file:${sha}` }} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-icon="initial"]')).toHaveTextContent('R');
  });

  it('不合规的 file: 引用直接走默认规则', () => {
    const { container } = render(<ProviderBrandIcon provider={{ provider: 'custom', alias: 'x', icon: 'file:../keys.json' }} />);
    expect(container.querySelector('img')).toBeNull();
  });
});
