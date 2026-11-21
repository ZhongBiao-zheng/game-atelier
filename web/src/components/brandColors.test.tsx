import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { COLOR_BRANDS, COLOR_FILES, MIN_CONTRAST, colorBrandSource } from './brandColors';
import { ModelBrandIcon } from './ModelBrandIcon';
import { ProviderBrandIcon } from './ProviderBrandIcon';
import { PROVIDER_BRANDS } from './providerBrands';
import { loadBrandIconMode, setBrandIconMode } from '@/lib/brandIconMode';
import { setTheme } from '@/lib/theme';

beforeEach(() => { localStorage.clear(); setTheme('dark'); });

describe('彩色品牌表（唯一判定处）', () => {
  it('表里的品牌与 assets/brands-color 下的文件一一对应，且都在内置品牌清单里', () => {
    expect([...COLOR_BRANDS].sort()).toEqual([...COLOR_FILES].sort());
    const known = new Set<string>(PROVIDER_BRANDS.map(brand => brand.id));
    expect(COLOR_BRANDS.filter(id => !known.has(id))).toEqual([]);
  });

  it('暗色下对比度不足 3:1 的品牌退回单色；亮色照常（2026-11-21 只限制暗色）', () => {
    expect(MIN_CONTRAST).toBe(3);
    for (const id of ['aws', 'baidu', 'doubao', 'siliconcloud', 'tencent', 'zhipu']) {
      expect(colorBrandSource(id, 'dark'), id).toBeNull();
      expect(colorBrandSource(id, 'light'), id).not.toBeNull();
    }
    for (const id of ['deepseek', 'gemini', 'openrouter', 'volcengine']) expect(colorBrandSource(id, 'dark'), id).not.toBeNull();
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
    rerender(<ProviderBrandIcon provider={{ provider: 'custom', icon: 'brand:tencent' }} size="sm" />);
    expect(container.querySelector('img')).toBeNull();  // 暗色下腾讯退回单色
    act(() => setTheme('light'));
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
