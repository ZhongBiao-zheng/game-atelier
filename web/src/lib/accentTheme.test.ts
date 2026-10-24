import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ACCENT_PRESETS } from './accentPresets';
import { accentColors, applyAccent, lightAccentColor, loadAccent, primaryForeground, setAccent, useAccent, accentCardContrast } from './accentTheme';
import { setTheme, startThemeSync } from './theme';

beforeEach(() => { localStorage.clear(); document.documentElement.style.cssText = ''; });
afterEach(() => { localStorage.clear(); document.documentElement.classList.remove('light'); });
describe('主题色存储与应用', () => {
  it.each(['{', 'null', '{}', '{"preset":"brass"}', '{"custom":{"primary":"red"}}'])('无效存储回到青柠：%s', raw => {
    localStorage.setItem('atelier:accent', raw);
    expect(loadAccent()).toEqual({ preset: 'lime' });
  });
  it('七套预设和自定义往返，并保持快照引用稳定', () => {
    for (const preset of ACCENT_PRESETS) {
      setAccent({ preset: preset.id });
      expect(loadAccent()).toEqual({ preset: preset.id });
      expect(accentColors(loadAccent()).primary).toBe(preset.primary);
      expect(loadAccent()).toBe(loadAccent());
    }
    const custom = { primary: '#333333', brand2: '#123456', brand3: '#ABCDEF', brand4: '#777777' };
    setAccent({ custom });
    expect(loadAccent()).toEqual({ custom });
  });
  it('主色文字选择对比度更高的黑或白', () => {
    expect(primaryForeground('#D4F53C')).toBe('#0A0A0B');
    expect(primaryForeground('#6F8BFF')).toBe('#0A0A0B');
    expect(primaryForeground('#333333')).toBe('#FFFFFF');
    expect(accentCardContrast('#333333', 'dark')).toBeLessThan(3);
  });
  it('浅色所有预设的 L 为 0.5，主副色对卡片均达到 3:1', () => {
    for (const preset of ACCENT_PRESETS) {
      for (const color of [preset.primary, preset.brand2, preset.brand3, preset.brand4]) {
        expect(lightAccentColor(color)).toMatch(/^oklch\(0\.5 /);
        expect(accentCardContrast(color, 'light')).toBeGreaterThanOrEqual(3);
      }
    }
  });
  it('亮暗切换重新应用派生值，不改保存的颜色', () => {
    setAccent({ preset: 'blue' });
    setTheme('light');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe(lightAccentColor('#6F8BFF'));
    setTheme('dark');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#6F8BFF');
    expect(loadAccent()).toEqual({ preset: 'blue' });
  });
  it('跨标签页更新及清空存储，即使外观页未挂载也应用', () => {
    const stop = startThemeSync();
    localStorage.setItem('atelier:accent', '{"preset":"orange"}');
    window.dispatchEvent(new StorageEvent('storage', { key: 'atelier:accent' }));
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#FF6B2C');
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#D4F53C');
    stop();
  });
  it('hook 订阅本页与其他标签页变更，应用不覆盖固定语义色', () => {
    const { result } = renderHook(useAccent);
    act(() => setAccent({ preset: 'pink' }));
    expect(result.current).toEqual({ preset: 'pink' });
    act(() => {
      localStorage.setItem('atelier:accent', '{"preset":"cyan"}');
      window.dispatchEvent(new StorageEvent('storage', { key: 'atelier:accent' }));
    });
    expect(result.current).toEqual({ preset: 'cyan' });
    applyAccent(result.current, 'dark');
    expect(document.documentElement.style.getPropertyValue('--chart-1')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--status-done')).toBe('');
  });
});
