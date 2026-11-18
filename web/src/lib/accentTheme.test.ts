import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ACCENT_PRESETS } from './accentPresets';
import {
  accentCardContrast, accentThemes, activeColors, applyAccent, DEFAULT_ACCENT, lightAccentColor, loadAccent,
  primaryForeground, startAccentSync, syncAccentThemes, updateAccentThemes, useAccent, type AccentDoc,
} from './accentTheme';
import { localConnection, type ConnectionSnapshot } from '@/api/connection';
import { setTheme, startThemeSync } from './theme';
import type { AccentThemes, AccentThemesBody } from '@/schema/accentThemes';

const api = vi.hoisted(() => ({ getAccentThemes: vi.fn(), saveAccentThemes: vi.fn() }));
vi.mock('@/api/accentThemes', () => api);

const LEGACY = { primary: '#333333', brand2: '#123456', brand3: '#ABCDEF', brand4: '#777777' };
const USER = { id: 'u-dusk0001', name: '晚霞', primary: '#FF8800', brand2: '#112233', brand3: '#445566', brand4: '#778899' };
const remote = (doc: Partial<AccentThemes> = {}): AccentThemes =>
  ({ schema_version: 1, revision: 0, active: 'lime', overrides: {}, custom: [], ...doc });
/** 假服务端：按 revision 校验并递增，与 viewer-server 行为一致。 */
function fakeServer(initial: AccentThemes) {
  let stored = initial;
  api.getAccentThemes.mockImplementation(async () => stored);
  api.saveAccentThemes.mockImplementation(async (revision: number, body: AccentThemesBody) => {
    if (revision !== stored.revision) throw new Error('主题已在别处修改');
    stored = { ...stored, ...body, revision: stored.revision + 1 };
    return stored;
  });
  return () => stored;
}
const cache = (doc: AccentDoc) => localStorage.setItem('atelier:accent', JSON.stringify({ doc }));
const primary = () => document.documentElement.style.getPropertyValue('--primary');

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear(); document.documentElement.style.cssText = '';
  api.getAccentThemes.mockReset(); api.saveAccentThemes.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); document.documentElement.classList.remove('light'); });

describe('主题缓存', () => {
  it.each(['{', 'null', '{}', '{"preset":"brass"}', '{"custom":{"primary":"red"}}', '{"doc":{"active":"lime"}}'])('无效缓存回到默认：%s', raw => {
    localStorage.setItem('atelier:accent', raw);
    expect(loadAccent()).toEqual(DEFAULT_ACCENT);
  });
  it('旧版预设缓存读成选中该内置主题', () => {
    localStorage.setItem('atelier:accent', '{"preset":"blue"}');
    expect(loadAccent()).toEqual({ ...DEFAULT_ACCENT, active: 'blue' });
    expect(activeColors(loadAccent()).primary).toBe('#6F8BFF');
  });
  it('旧版自定义颜色读成一个已选中的用户主题，首帧就用它的颜色', () => {
    localStorage.setItem('atelier:accent', JSON.stringify({ custom: LEGACY }));
    const doc = loadAccent();
    expect(doc.custom).toEqual([{ id: 'u-333333123456abcdef777777', name: '自定义', ...LEGACY }]);
    expect(doc.active).toBe(doc.custom[0].id);
    expect(loadAccent()).toBe(doc);
    setTheme('dark');
    expect(primary()).toBe('#333333');
  });
  it('网格列表：内置在前、改过的内置标记 edited、用户主题在后', () => {
    const doc: AccentDoc = { ...DEFAULT_ACCENT, overrides: { pink: LEGACY }, custom: [USER] };
    const themes = accentThemes(doc);
    expect(themes.map(theme => theme.id)).toEqual([...ACCENT_PRESETS.map(preset => preset.id), USER.id]);
    expect(themes.find(theme => theme.id === 'pink')).toMatchObject({ edited: true, colors: LEGACY, name: '珊瑚粉' });
    expect(themes.at(-1)).toMatchObject({ builtin: false, name: '晚霞', colors: { primary: '#FF8800' } });
  });
});

describe('服务端同步', () => {
  it('服务端从未保存：本机旧版自定义颜色整份迁移上去', async () => {
    const stored = fakeServer(remote());
    localStorage.setItem('atelier:accent', JSON.stringify({ custom: LEGACY }));
    await syncAccentThemes();
    expect(stored()).toMatchObject({ revision: 1, active: 'u-333333123456abcdef777777', custom: [{ name: '自定义', ...LEGACY }] });
    expect(JSON.parse(localStorage.getItem('atelier:accent')!).doc.revision).toBe(1);
  });
  it('服务端已有主题：旧版自定义颜色追加成用户主题，不改当前选择，重名自动编号', async () => {
    const stored = fakeServer(remote({ revision: 3, active: 'cyan', custom: [{ ...USER, name: '自定义' }] }));
    localStorage.setItem('atelier:accent', JSON.stringify({ custom: LEGACY }));
    await syncAccentThemes();
    expect(stored().active).toBe('cyan');
    expect(stored().custom.map(theme => theme.name)).toEqual(['自定义', '自定义 2']);
    expect(primary()).toBe('#3EE6D0');
    await syncAccentThemes();
    expect(api.saveAccentThemes).toHaveBeenCalledTimes(1);
  });
  it('服务端已有：以服务端为准，不回写本机缓存的旧选择', async () => {
    fakeServer(remote({ revision: 2, active: USER.id, custom: [USER] }));
    cache({ ...DEFAULT_ACCENT, revision: 1, active: 'blue' });
    await syncAccentThemes();
    expect(api.saveAccentThemes).not.toHaveBeenCalled();
    expect(loadAccent().active).toBe(USER.id);
    expect(primary()).toBe('#FF8800');
  });
  it('连接每次进入就绪才同步，未就绪不发请求', async () => {
    fakeServer(remote({ revision: 2, active: 'pink' }));
    let phase: ConnectionSnapshot['phase'] = 'connecting';
    let listener = () => {};
    const snapshot = vi.spyOn(localConnection, 'getSnapshot').mockImplementation(() => ({ phase, generation: 1, editing: true, message: null }));
    const subscribe = vi.spyOn(localConnection, 'subscribe').mockImplementation(next => { listener = next; return () => {}; });
    startAccentSync();
    expect(api.getAccentThemes).not.toHaveBeenCalled();
    phase = 'ready'; listener(); listener();
    await vi.waitFor(() => expect(loadAccent().active).toBe('pink'));
    expect(api.getAccentThemes).toHaveBeenCalledTimes(1);
    phase = 'interrupted'; listener();
    phase = 'ready'; listener();
    await vi.waitFor(() => expect(api.getAccentThemes).toHaveBeenCalledTimes(2));
    snapshot.mockRestore(); subscribe.mockRestore();
  });
  it('保存失败回滚到改动前', async () => {
    fakeServer(remote({ revision: 1 }));
    cache({ ...DEFAULT_ACCENT, revision: 1 });
    api.saveAccentThemes.mockRejectedValueOnce(new Error('保存主题色失败'));
    await expect(updateAccentThemes(doc => ({ ...doc, active: 'pink' }))).rejects.toThrow('保存主题色失败');
    expect(loadAccent().active).toBe('lime');
    expect(primary()).toBe('#D4F53C');
  });
  it('连续保存串行，每笔用上一笔返回的 revision', async () => {
    const stored = fakeServer(remote({ revision: 1 }));
    cache({ ...DEFAULT_ACCENT, revision: 1 });
    await Promise.all([
      updateAccentThemes(doc => ({ ...doc, active: 'pink' })),
      updateAccentThemes(doc => ({ ...doc, custom: [...doc.custom, USER] })),
      updateAccentThemes(doc => ({ ...doc, active: USER.id })),
    ]);
    expect(stored()).toMatchObject({ revision: 4, active: USER.id, custom: [USER] });
    expect(loadAccent().revision).toBe(4);
  });
});

describe('颜色派生', () => {
  it('主色文字选择对比度更高的黑或白', () => {
    expect(primaryForeground('#D4F53C')).toBe('#0A0A0B');
    expect(primaryForeground('#6F8BFF')).toBe('#0A0A0B');
    expect(primaryForeground('#333333')).toBe('#FFFFFF');
    expect(accentCardContrast('#333333', 'dark')).toBeLessThan(3);
  });
  it('浅色主题的主色按钮内容一律用白色', () => {
    for (const preset of ACCENT_PRESETS) expect(primaryForeground(preset.primary, 'light')).toBe('#FFFFFF');
    expect(primaryForeground('#333333', 'light')).toBe('#FFFFFF');
  });
  it('浅色只压到对卡片刚好 3:1，不再一刀切到 0.5', () => {
    for (const preset of ACCENT_PRESETS) {
      for (const color of [preset.primary, preset.brand2, preset.brand3, preset.brand4]) {
        expect(accentCardContrast(color, 'light')).toBeGreaterThanOrEqual(3);
      }
    }
    const limeL = Number(lightAccentColor('#D4F53C').match(/^oklch\(([\d.]+) /)![1]);
    expect(limeL).toBeGreaterThanOrEqual(0.6);
    expect(lightAccentColor('#333333')).toMatch(/^oklch\(0\.3\d* /);
  });
  it('用户主题同样走浅色压暗与白色按钮文字，亮暗切换不改保存的颜色', () => {
    cache({ ...DEFAULT_ACCENT, active: USER.id, custom: [USER] });
    setTheme('light');
    expect(primary()).toBe(lightAccentColor('#FF8800'));
    expect(document.documentElement.style.getPropertyValue('--primary-foreground')).toBe('#FFFFFF');
    setTheme('dark');
    expect(primary()).toBe('#FF8800');
    expect(loadAccent().custom).toEqual([USER]);
  });
  it('跨标签页更新及清空存储，即使外观页未挂载也应用', () => {
    const stop = startThemeSync();
    cache({ ...DEFAULT_ACCENT, active: 'orange' });
    window.dispatchEvent(new StorageEvent('storage', { key: 'atelier:accent' }));
    expect(primary()).toBe('#FF6B2C');
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(primary()).toBe('#D4F53C');
    stop();
  });
  it('hook 订阅其他标签页变更，应用不覆盖固定语义色', () => {
    const { result } = renderHook(useAccent);
    act(() => {
      cache({ ...DEFAULT_ACCENT, active: 'cyan' });
      window.dispatchEvent(new StorageEvent('storage', { key: 'atelier:accent' }));
    });
    expect(result.current.active).toBe('cyan');
    applyAccent(activeColors(result.current), 'dark');
    expect(document.documentElement.style.getPropertyValue('--chart-1')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--status-done')).toBe('');
  });
});
