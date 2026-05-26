import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { AppShell } from './AppShell';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  const { hook } = memoryLocation({ path, static: true });
  return render(
    <Router hook={hook}>
      <AppShell />
    </Router>,
  );
}

describe('AppShell', () => {
  it('renders Atelier logo on every route', () => {
    renderAt('/studio');
    expect(screen.getByText('Atelier')).toBeInTheDocument();
  });

  it('highlights 出图 tab on /studio', () => {
    renderAt('/studio');
    const tab = screen.getByText('出图');
    expect(tab.className).toContain('bg-card/70');
  });

  it('highlights 工坊 tab on /character/foo', () => {
    renderAt('/character/foo');
    const tab = screen.getByText('工坊');
    expect(tab.className).toContain('bg-card/70');
  });

  it('does not highlight either tab on /', () => {
    renderAt('/');
    expect(screen.getByText('出图').className).not.toContain('bg-card/70');
    expect(screen.getByText('工坊').className).not.toContain('bg-card/70');
    expect(screen.getByText('主页').className).toContain('bg-card/70');
  });

  it('Keys icon turns primary on /settings/keys', () => {
    renderAt('/settings/keys');
    const link = screen.getByLabelText('API Keys 设置');
    expect(link.className).toContain('text-primary');
  });
});
