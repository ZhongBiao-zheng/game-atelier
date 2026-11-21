import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { COLOR_BRANDS, MONO_IN, colorBrandSource } from './brandColors';
import { ModelBrandIcon } from './ModelBrandIcon';
import { ProviderBrandIcon } from './ProviderBrandIcon';
import { PROVIDER_BRANDS } from './providerBrands';
import { loadBrandIconMode, setBrandIconMode } from '@/lib/brandIconMode';
import { setTheme } from '@/lib/theme';

beforeEach(() => { localStorage.clear(); setTheme('dark'); });

describe('彩色品牌与退回名单（唯一判定处）', () => {
  it('有彩色版的品牌都在内置品牌清单里，退回名单里的品牌都有彩色版', () => {
    const known = new Set<string>(PROVIDER_BRANDS.map(brand => brand.id));
    expect(COLOR_BRANDS.filter(id => !known.has(id))).toEqual([]);
    expect([...MONO_IN.light, ...MONO_IN.dark].filter(id => !COLOR_BRANDS.includes(id))).toEqual([]);
  });

  it('名单里的品牌只在对应主题下退回单色，另一主题照常彩色', () => {
    expect(colorBrandSource('openrouter', 'light')).toBeNull();
    expect(colorBrandSource('openrouter', 'dark')).not.toBeNull();
    for (const id of ['aws', 'baidu']) {
      expect(colorBrandSource(id, 'dark'), id).toBeNull();
      expect(colorBrandSource(id, 'light'), id).not.toBeNull();
    }
  });

  it('不在名单里的品牌两种主题都是彩色', () => {
    for (const id of ['google', 'tencent']) {
      expect(colorBrandSource(id, 'light'), id).not.toBeNull();
      expect(colorBrandSource(id, 'dark'), id).not.toBeNull();
    }
  });

  it('没有彩色版的品牌两种主题都是单色', () => {
    for (const id of ['anthropic', 'openai', 'midjourney', 'flux', 'moonshot', 'xai', 'runway', 'replicate']) {
      expect(colorBrandSource(id, 'dark'), id).toBeNull();
      expect(colorBrandSource(id, 'light'), id).toBeNull();
    }
  });
});

describe('品牌图标「黑白 / 彩色」', () => {
  it('没设过时按黑白：品牌图标是 currentColor 的单色 SVG', () => {
    expect(loadBrandIconMode()).toBe('mono');
    const { container } = render(<ModelBrandIcon brand="deepseek" size="sm" />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
    expect(container.querySelector('img')).toBeNull();
  });

  it('切到彩色：有彩色版且对比度够的品牌换成彩色图片，尺寸不变；不够的保持单色', () => {
    const { container, rerender } = render(<ModelBrandIcon brand="deepseek" size="sm" />);
    act(() => setBrandIconMode('color'));
    const image = container.querySelector('img')!;
    expect(image).toHaveAttribute('width', '14');
    expect(image.getAttribute('src')).toBeTruthy();
    rerender(<ProviderBrandIcon provider={{ provider: 'custom', icon: 'brand:baidu' }} size="sm" />);
    expect(container.querySelector('img')).toBeNull();  // 暗色下百度退回单色
    act(() => setTheme('light'));
    expect(container.querySelector('img')).not.toBeNull();  // 亮色下照常彩色
    rerender(<ProviderBrandIcon provider={{ provider: 'openrouter' }} size="sm" />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');  // 亮色下 OpenRouter 退回单色
    act(() => setTheme('dark'));
    expect(container.querySelector('img')).not.toBeNull();
    rerender(<ModelBrandIcon brand="anthropic" size="sm" />);
    expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });

  it('上传的图标两种模式都按原色显示，供应商遮罩图标两种模式都是单色', () => {
    const sha = 'c'.repeat(64);
    for (const mode of ['mono', 'color'] as const) {
      act(() => setBrandIconMode(mode));
      const { container, unmount } = render(<>
        <ProviderBrandIcon provider={{ provider: 'custom', icon: `file:${sha}` }} />
        <ProviderBrandIcon provider={{ provider: 'custom', base_url: 'https://api.tu-zi.com' }} />
      </>);
      expect(container.querySelector('img')).toHaveAttribute('src', `/api/provider-icons/${sha}`);
      expect(container.querySelector('.bg-current')).not.toBeNull();
      unmount();
    }
  });
});
