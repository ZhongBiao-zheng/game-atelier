import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DESKTOP_DOWNLOAD_EVENT, DesktopDownloadNotice } from './DesktopDownloadNotice';
import { Toaster } from '@/components/ui/sonner';

afterEach(() => {
  delete document.documentElement.dataset.shell;
  delete (window as unknown as { atelierShell?: unknown }).atelierShell;
});

it('tells the user where the desktop shell saved a download', async () => {
  render(<><Toaster /><DesktopDownloadNotice /></>);
  act(() => {
    window.dispatchEvent(new CustomEvent(DESKTOP_DOWNLOAD_EVENT, { detail: { name: 'canvas.zip' } }));
  });
  expect(await screen.findByText('已保存到「下载」：canvas.zip')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '打开所在文件夹' })).not.toBeInTheDocument();
});

it('opens the saved file in its folder through the shell', async () => {
  const showDownload = vi.fn();
  document.documentElement.dataset.shell = 'macos';
  (window as unknown as { atelierShell: unknown }).atelierShell = { setTheme: vi.fn(), showDownload };
  render(<><Toaster /><DesktopDownloadNotice /></>);
  act(() => {
    window.dispatchEvent(new CustomEvent(DESKTOP_DOWNLOAD_EVENT, { detail: { name: 'cat.png', id: '7' } }));
  });
  await userEvent.click(await screen.findByRole('button', { name: '打开所在文件夹' }));
  expect(showDownload).toHaveBeenCalledWith('7');
});
