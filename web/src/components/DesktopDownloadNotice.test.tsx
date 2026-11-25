import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DESKTOP_DOWNLOAD_EVENT, DesktopDownloadNotice } from './DesktopDownloadNotice';
import { Toaster } from '@/components/ui/sonner';

it('tells the user where the desktop shell saved a download', async () => {
  render(<><Toaster /><DesktopDownloadNotice /></>);
  act(() => {
    window.dispatchEvent(new CustomEvent(DESKTOP_DOWNLOAD_EVENT, { detail: { name: 'canvas.zip' } }));
  });
  expect(await screen.findByText('已保存到「下载」：canvas.zip')).toBeInTheDocument();
});
