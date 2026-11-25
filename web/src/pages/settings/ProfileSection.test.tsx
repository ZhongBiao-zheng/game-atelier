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

  it('改名后回车即保存（单值控件即时保存）', async () => {
    render(<ProfileSection />);
    const input = await screen.findByLabelText('显示名');
    await waitFor(() => expect(input).toHaveValue('老王'));

    fireEvent.change(input, { target: { value: '小李' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledWith('小李'));
    expect(await screen.findByRole('img', { name: '已保存' })).toBeInTheDocument();
  });

  it('空串时不保存并标出无效', async () => {
    render(<ProfileSection />);
    const input = await screen.findByLabelText('显示名');
    await waitFor(() => expect(input).toHaveValue('老王'));

    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(mockSaveProfile).not.toHaveBeenCalled();
  });
});

it('仅空白变化或改回原值时不保存', async () => {
  render(<ProfileSection />);
  const input = await screen.findByLabelText('显示名');
  await waitFor(() => expect(input).toHaveValue('老王'));
  fireEvent.change(input, { target: { value: ' 老王 ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(mockSaveProfile).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '小李' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledOnce());
  expect(input).toHaveValue('小李');
  fireEvent.change(input, { target: { value: '临时' } });
  fireEvent.change(input, { target: { value: '小李' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(mockSaveProfile).toHaveBeenCalledOnce();
});
it('保存失败保留编辑值和重试入口', async () => {
  mockSaveProfile.mockRejectedValueOnce(new Error('保存失败'));
  render(<ProfileSection />);
  const input = await screen.findByLabelText('显示名');
  await waitFor(() => expect(input).toHaveValue('老王'));
  fireEvent.change(input, { target: { value: '小李' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
  expect(input).toHaveValue('小李');
  // 再回车就是重试。
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(mockSaveProfile).toHaveBeenCalledTimes(2));
});
