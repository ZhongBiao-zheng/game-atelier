import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ProfileSection } from './ProfileSection';
import { fetchProfile, saveProfile } from '@/api/teamLibraries';

vi.mock('@/api/teamLibraries', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/teamLibraries')>();
  return {
    ...actual,
    fetchProfile: vi.fn(),
    saveProfile: vi.fn(),
  };
});

const mockFetchProfile = vi.mocked(fetchProfile);
const mockSaveProfile = vi.mocked(saveProfile);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchProfile.mockResolvedValue({ display_name: '老王' });
  mockSaveProfile.mockImplementation(async name => ({ display_name: name }));
});

describe('ProfileSection', () => {
  it('显示当前显示名', async () => {
    render(<ProfileSection />);
    const input = await screen.findByLabelText('显示名');
    await waitFor(() => expect(input).toHaveValue('老王'));
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
  });

  it('改名后点保存调用 saveProfile', async () => {
    render(<ProfileSection />);
    const input = await screen.findByLabelText('显示名');
    await waitFor(() => expect(input).toHaveValue('老王'));

    fireEvent.change(input, { target: { value: '小李' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith('小李'));
  });

  it('空串时保存禁用', async () => {
    render(<ProfileSection />);
    const input = await screen.findByLabelText('显示名');
    await waitFor(() => expect(input).toHaveValue('老王'));

    fireEvent.change(input, { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});

it('保存成功隐藏按钮，撤回改动或仅空白变化也不显示', async () => {
  render(<ProfileSection />);
  const input = await screen.findByLabelText('显示名');
  await waitFor(() => expect(input).toHaveValue('老王'));
  fireEvent.change(input, { target: { value: ' 老王 ' } });
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: '小李' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /保存/ })).not.toBeInTheDocument());
  expect(input).toHaveValue('小李');
  fireEvent.change(input, { target: { value: '临时' } });
  fireEvent.change(input, { target: { value: '小李' } });
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
});
it('保存失败保留编辑值和重试入口', async () => {
  mockSaveProfile.mockRejectedValueOnce(new Error('保存失败'));
  render(<ProfileSection />);
  const input = await screen.findByLabelText('显示名');
  await waitFor(() => expect(input).toHaveValue('老王'));
  fireEvent.change(input, { target: { value: '小李' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
  expect(input).toHaveValue('小李');
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
});
