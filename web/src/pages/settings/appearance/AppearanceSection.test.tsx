import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppearanceSection } from './AppearanceSection';
import { DEFAULT_ACCENT, loadAccent } from '@/lib/accentTheme';
import { loadTheme, setTheme, startThemeSync } from '@/lib/theme';
import type { AccentThemes, AccentThemesBody } from '@/schema/accentThemes';
import { ACCENT_USER_THEME_MAX } from '@/schema/accentThemes';

const api = vi.hoisted(() => ({ getAccentThemes: vi.fn(), saveAccentThemes: vi.fn() }));
vi.mock('@/api/accentThemes', () => api);

const USER = { id: 'u-dusk0001', name: '晚霞', primary: '#FF8800', brand2: '#112233', brand3: '#445566', brand4: '#778899' };
let stored: AccentThemes;
function serve(doc: Partial<AccentThemes> = {}) {
  stored = { schema_version: 1, revision: 1, active: 'lime', overrides: {}, custom: [], ...doc };
  localStorage.setItem('atelier:accent', JSON.stringify({ doc: { revision: stored.revision, active: stored.active, overrides: stored.overrides, custom: stored.custom } }));
  api.getAccentThemes.mockImplementation(async () => stored);
  api.saveAccentThemes.mockImplementation(async (revision: number, body: AccentThemesBody) => {
    if (revision !== stored.revision) throw new Error('主题已在别处修改');
    stored = { ...stored, ...body, revision: stored.revision + 1 };
    return stored;
  });
}
async function renderSection() {
  render(<AppearanceSection />);
  await waitFor(() => expect(api.getAccentThemes).toHaveBeenCalled());
  await act(async () => {});
}
const tile = (name: string) => screen.getByRole('radio', { name });
const openEditor = () => fireEvent.click(screen.getByText('编辑主题'));
const setColor = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { localStorage.clear(); setTheme('dark'); api.getAccentThemes.mockReset(); api.saveAccentThemes.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('点色块切换并保存当前主题', async () => {
  serve();
  await renderSection();
  fireEvent.click(tile('钴蓝'));
  await waitFor(() => expect(stored.active).toBe('blue'));
  expect(tile('钴蓝')).toHaveAttribute('aria-checked', 'true');
  expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#6F8BFF');
});

it('「+」新增：默认名称可直接创建，重名不能提交，创建后选中新主题', async () => {
  serve({ custom: [USER] });
  await renderSection();
  fireEvent.click(screen.getByRole('button', { name: '新增主题' }));
  const dialog = await screen.findByRole('dialog');
  const name = within(dialog).getByLabelText('名称');
  expect(name).toHaveValue('新主题');
  fireEvent.change(name, { target: { value: ' 晚霞 ' } });
  expect(within(dialog).getByRole('alert')).toHaveTextContent('名称已存在');
  expect(within(dialog).getByRole('button', { name: '创建' })).toBeDisabled();
  fireEvent.change(name, { target: { value: '青柠' } });
  expect(within(dialog).getByRole('button', { name: '创建' })).toBeDisabled();
  fireEvent.change(name, { target: { value: '  深海  ' } });
  fireEvent.change(within(dialog).getByLabelText('主色'), { target: { value: '#0055AA' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const created = stored.custom.at(-1)!;
  expect(created).toMatchObject({ name: '深海', primary: '#0055AA' });
  expect(created.id).toMatch(/^u-[a-z0-9]{8,32}$/);
  expect(stored.active).toBe(created.id);
  expect(tile('深海')).toHaveAttribute('aria-checked', 'true');
});

it('用户主题到上限后不再显示「+」', async () => {
  serve({ custom: Array.from({ length: ACCENT_USER_THEME_MAX }, (_, index) => ({ ...USER, id: `u-theme${String(index).padStart(4, '0')}`, name: `主题${index}` })) });
  await renderSection();
  expect(screen.queryByRole('button', { name: '新增主题' })).not.toBeInTheDocument();
});

it('编辑内置主题：草稿实时预览，保存成改色；恢复默认要确认', async () => {
  serve({ active: 'blue' });
  await renderSection();
  openEditor();
  expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  setColor('主色', '#33');
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  setColor('主色', '#333333');
  expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#333333');
  expect(screen.getByRole('status')).toHaveTextContent('对比度较低');
  expect(stored.overrides).toEqual({});
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(stored.overrides.blue?.primary).toBe('#333333'));
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
  const confirm = await screen.findByRole('alertdialog');
  expect(confirm).toHaveTextContent('恢复「钴蓝」的默认设置？');
  fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
  expect(stored.overrides.blue?.primary).toBe('#333333');
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '恢复' }));
  await waitFor(() => expect(stored.overrides).toEqual({}));
  expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#6F8BFF');
  expect(screen.queryByRole('button', { name: '恢复默认' })).not.toBeInTheDocument();
});

it('内置主题可重命名，名称不与其他主题冲突，恢复默认后改回原名', async () => {
  serve({ active: 'lime', custom: [USER] });
  await renderSection();
  openEditor();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '晚霞' } });
  expect(screen.getByRole('alert')).toHaveTextContent('名称已存在');
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '电光紫' } });
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: ' 晨光 ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(stored.overrides.lime).toEqual({ primary: '#D4F53C', brand2: '#6FD6F0', brand3: '#F5D06A', brand4: '#A99FF5', name: '晨光' }));
  expect(tile('晨光')).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '恢复' }));
  await waitFor(() => expect(stored.overrides).toEqual({}));
  expect(tile('青柠')).toHaveAttribute('aria-checked', 'true');
});

it('切走或关闭编辑区时撤掉没保存的草稿预览', async () => {
  serve();
  await renderSection();
  openEditor();
  setColor('主色', '#333333');
  expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#333333');
  fireEvent.click(tile('信号橙'));
  await waitFor(() => expect(stored.active).toBe('orange'));
  expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#FF6B2C');
  expect(stored.overrides).toEqual({});
});

it('用户主题：重命名、另存为新主题、删除需确认且回到默认', async () => {
  serve({ active: USER.id, custom: [USER] });
  await renderSection();
  openEditor();
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '珊瑚粉' } });
  expect(screen.getByRole('alert')).toHaveTextContent('名称已存在');
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '暮色' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(stored.custom[0].name).toBe('暮色'));
  expect(tile('暮色')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '另存为新主题' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('名称')).toHaveValue('暮色 2');
  fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));
  await waitFor(() => expect(stored.custom.map(theme => theme.name)).toEqual(['暮色', '暮色 2']));

  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  const confirm = await screen.findByRole('alertdialog');
  expect(confirm).toHaveTextContent('删除「暮色 2」？');
  fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(stored.custom.map(theme => theme.name)).toEqual(['暮色']));
  expect(stored.active).toBe('lime');
  expect(tile('青柠')).toHaveAttribute('aria-checked', 'true');
});

it('保存失败显示原因并回滚', async () => {
  serve();
  await renderSection();
  api.saveAccentThemes.mockRejectedValueOnce(new Error('保存主题色失败：服务端内部出错'));
  fireEvent.click(tile('钴蓝'));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存主题色失败');
  expect(loadAccent().active).toBe('lime');
  expect(tile('青柠')).toHaveAttribute('aria-checked', 'true');
});

it('旧版自定义颜色在打开设置页时转成名为「自定义」的主题', async () => {
  serve({ revision: 0 });
  localStorage.setItem('atelier:accent', JSON.stringify({ custom: { primary: '#333333', brand2: '#123456', brand3: '#ABCDEF', brand4: '#777777' } }));
  await renderSection();
  await waitFor(() => expect(stored.revision).toBe(1));
  expect(stored.custom).toEqual([expect.objectContaining({ name: '自定义', primary: '#333333' })]);
  expect(tile('自定义')).toHaveAttribute('aria-checked', 'true');
  expect(loadAccent()).not.toEqual(DEFAULT_ACCENT);
});

it('跟随系统响应系统变化，手动切换后停止跟随', () => {
  let handler = () => {};
  const media = { matches: false, addEventListener: (_: string, cb: () => void) => { handler = cb; }, removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => media);
  const stop = startThemeSync();
  render(<AppearanceSection />);
  fireEvent.click(screen.getByRole('radio', { name: '跟随系统' }));
  expect(loadTheme()).toBe('system');
  act(() => { media.matches = true; handler(); });
  expect(document.documentElement).toHaveClass('light');
  expect(document.documentElement.style.getPropertyValue('--primary')).toMatch(/^oklch/);
  act(() => setTheme('dark'));
  act(() => handler());
  expect(document.documentElement).not.toHaveClass('light');
  expect(screen.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true');
  stop();
});
