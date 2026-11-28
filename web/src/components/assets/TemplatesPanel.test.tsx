import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { deleteTemplate, listTemplates } from '@/api/templates';
import { notify } from '@/lib/notify';
import { TemplateNameDialog } from './TemplateNameDialog';
import { TemplatesPanel } from './TemplatesPanel';

vi.mock('@/lib/uiPrefs', () => ({ loadUiPrefs: async () => ({}), saveUiPref: vi.fn() }));
vi.mock('@/api/templates', async original => ({
  ...await original<typeof import('@/api/templates')>(), listTemplates: vi.fn(), deleteTemplate: vi.fn(),
}));

it('shows the save hint for an empty personal library', async () => {
  vi.mocked(listTemplates).mockResolvedValue({ items: [] });
  render(<TemplatesPanel />);
  expect(await screen.findByText('在画布里选中一个组，点「存为模板」')).toBeVisible();
  expect(within(screen.getByRole('region', { name: '团队共享' })).getByText('还没有模板')).toBeVisible();
});

it('shows the paste action only on canvas', async () => {
  vi.mocked(listTemplates).mockResolvedValue({ items: [{ id: 'tpl_1', name: '分镜', node_count: 4, cover: null }] });
  const view = render(<TemplatesPanel />);
  const card = await screen.findByRole('article', { name: '分镜' });
  expect(within(card).getByText('4 个节点')).toBeVisible();
  expect(within(card).queryByRole('button', { name: '添加到画布' })).toBeNull();
  const add = vi.fn(async () => {});
  view.rerender(<TemplatesPanel onAdd={add} />);
  fireEvent.click(within(card).getByRole('button', { name: '添加到画布' }));
  await waitFor(() => expect(add).toHaveBeenCalledWith('tpl_1'));
});

it('saves the group name and keeps a failed save editable', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('写入失败')).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<TemplateNameDialog initialName="海岸分镜" title="存为模板" onClose={close} onSave={save} />);
  expect(screen.getByRole('textbox')).toHaveValue('海岸分镜');
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('写入失败');
  expect(close).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: ' 新分镜 ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenLastCalledWith('新分镜');
});

it('removes the card while deletion is pending and restores it in place on failure', async () => {
  const items = ['分镜', '海岸'].map(name => ({ id: name, name, node_count: 1, cover: null }));
  vi.mocked(listTemplates).mockResolvedValue({ items });
  let fail!: (reason: Error) => void;
  vi.mocked(deleteTemplate).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  const error = vi.spyOn(notify, 'error').mockReturnValue(0);
  render(<TemplatesPanel />);
  fireEvent.keyDown(await screen.findByRole('button', { name: '分镜 更多操作' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
  expect(deleteTemplate).toHaveBeenCalledWith('分镜');
  expect(screen.queryByRole('article', { name: '分镜' })).toBeNull();
  expect(screen.getByRole('article', { name: '海岸' })).toBeVisible();
  fail(new Error('删除失败'));
  await screen.findByRole('article', { name: '分镜' });
  expect(screen.getAllByRole('article').map(card => card.getAttribute('aria-label'))).toEqual(['分镜', '海岸']);
  expect(error).toHaveBeenCalledWith('删除失败');
  error.mockRestore();
});
