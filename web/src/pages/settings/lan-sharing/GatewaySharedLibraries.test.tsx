import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { getManagedGatewayShares, stopManagedGatewayShare } from '@/api/gatewayLibraries';
import { GatewaySharedLibraries } from './GatewaySharedLibraries';
vi.mock('@/api/gatewayLibraries', () => ({ getManagedGatewayShares: vi.fn(), stopManagedGatewayShare: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it('共享库按量级显示容量，停止共享需要确认并刷新列表', async () => {
  vi.mocked(getManagedGatewayShares).mockResolvedValue({ size_bytes: 3 * 1024 ** 3, libraries: [
    { id: 'small', name: '小图库', owner_name: '林晓', counts: { raw: 5 }, size_bytes: 23 * 1024, updated_at: '' },
    { id: 'large', name: '视频库', owner_name: '小李', counts: { raw: 1 }, size_bytes: 2.5 * 1024 ** 2, updated_at: '' },
  ] });
  vi.mocked(stopManagedGatewayShare).mockResolvedValue({ size_bytes: 0, libraries: [] });
  render(<GatewaySharedLibraries />);
  expect(await screen.findByText('23.0 KB')).toBeInTheDocument();
  expect(screen.getByText('2.5 MB')).toBeInTheDocument();
  expect(screen.getByText('合计 3.0 GB')).toBeInTheDocument();
  const row = screen.getByText('小图库').closest('tr')!;
  expect(within(row).getByText('林晓')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: '停止共享' }));
  expect(stopManagedGatewayShare).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '停止共享' }));
  await waitFor(() => expect(stopManagedGatewayShare).toHaveBeenCalledWith('small'));
  expect(await screen.findByText('暂无共享库')).toBeInTheDocument();
});
