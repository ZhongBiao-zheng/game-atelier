import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { fetchGatewayProviderMe } from '@/api/gateway';
import { GatewayQuota } from './GatewayQuota';
vi.mock('@/api/gateway', () => ({ fetchGatewayProviderMe: vi.fn() }));
it('shows each limit and silently hides unavailable quota', async () => {
  vi.mocked(fetchGatewayProviderMe).mockResolvedValue({ name: 'A', month_calls: 1, month_charged_cny: 12.4,
    limits: [{ period: 'week', cap_cny: 200, used_cny: 12.4, reserved_cny: 0, left_cny: 187.6, resets_at: '2026-10-27T00:00:00+08:00' }] });
  const view = render(<GatewayQuota alias="Hub" />);
  expect(await screen.findByText(/本周 ¥ 12.4 \/ ¥ 200/)).toBeInTheDocument();
  vi.mocked(fetchGatewayProviderMe).mockRejectedValue(new Error('offline'));
  view.rerender(<GatewayQuota alias="Other" />);
  await waitFor(() => expect(screen.queryByLabelText('中转额度')).not.toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
