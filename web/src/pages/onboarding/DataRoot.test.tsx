import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DataRootPage } from './DataRoot';

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

describe('DataRootPage', () => {
  it('posts the selected path on save', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ path: '/tmp/x' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data_root: '/tmp/x' }),
      });
    const onComplete = vi.fn();
    render(<DataRootPage onComplete={onComplete} />);
    expect(screen.queryByLabelText(/数据目录路径/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '自定义' }));
    fireEvent.click(screen.getByText(/选择文件夹/));
    await waitFor(() => expect(screen.getByLabelText(/数据目录路径/)).toHaveValue('/tmp/x'));
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      '/api/onboarding/data-root',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/tmp/x' }),
      }),
    );
  });

  it('shows the platform default as an option', () => {
    render(<DataRootPage onComplete={() => {}} />);
    expect(screen.getByRole('radio', { name: /~\/game-atelier.*推荐/ })).toBeChecked();
    expect(screen.queryByText(/Game Atelier/)).not.toBeInTheDocument();
  });
});
