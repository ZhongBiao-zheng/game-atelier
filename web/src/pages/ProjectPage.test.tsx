// web/src/pages/ProjectPage.test.tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPage } from './ProjectPage';

const sample = {
  project: { id: 'p1', slug: 'pokemon', name: '宝可梦风格', created_at: '2026-06-24T00:00:00+00:00', character_count: 3 },
  worldview_md: '暖色调',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
    return { ok: true, json: async () => sample } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('ProjectPage', () => {
  it('渲染项目信息 + 可编辑 worldview', async () => {
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect((screen.getByLabelText('项目经验 / 世界观') as HTMLTextAreaElement).value).toBe('暖色调');
  });

  it('无改动时保存禁用，改动后可保存并 POST', async () => {
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText('项目经验 / 世界观'));
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('项目经验 / 世界观'), { target: { value: '暖色调，避免 IP' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/experience', expect.objectContaining({ method: 'POST' })),
    );
  });
});
