import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { COLOR_BRANDS, COLOR_FILES, COLOR_TABLE, MIN_CONTRAST, colorBrandSource } from './brandColors';
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

  it('两种主题同一条规则：对比度低于 3:1 的品牌只在该主题下退回单色，另一主题照常彩色', () => {
    expect(MIN_CONTRAST).toBe(3);
    const darkOnlyMono = ['aws', 'baidu', 'doubao', 'siliconcloud', 'tencent', 'zhipu'];
    const lightOnlyMono = ['alibaba', 'bytedance', 'gemini', 'google', 'kling', 'mistral', 'newapi', 'openrouter', 'volcengine'];
    for (const id of darkOnlyMono) {
      expect(colorBrandSource(id, 'dark'), id).toBeNull();
      expect(colorBrandSource(id, 'light'), id).not.toBeNull();
    }
    for (const id of lightOnlyMono) {
      expect(colorBrandSource(id, 'light'), id).toBeNull();
      expect(colorBrandSource(id, 'dark'), id).not.toBeNull();
    }
    for (const id of ['azure', 'deepseek', 'fal', 'minimax']) {
      expect(colorBrandSource(id, 'light'), id).not.toBeNull();
      expect(colorBrandSource(id, 'dark'), id).not.toBeNull();
    }
    expect([...darkOnlyMono, ...lightOnlyMono, 'azure', 'deepseek', 'fal', 'minimax'].sort()).toEqual([...COLOR_BRANDS].sort());
  });

  it('表里每个主题的结果都由实测对比度与同一阈值判出', () => {
    for (const [brand, themes] of Object.entries(COLOR_TABLE)) {
      for (const theme of ['light', 'dark'] as const) {
        expect(themes[theme].color, `${brand} ${theme}`).toBe(themes[theme].contrast >= MIN_CONTRAST);
      }
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
    rerender(<ProviderBrandIcon provider={{ provider: 'custom', icon: 'brand:tencent' }} size="sm" />);
    expect(container.querySelector('img')).toBeNull();  // 暗色下腾讯退回单色
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
