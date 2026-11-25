import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { pointerDownOutside } from '@/test/hint';

import { ChangelogButton } from './ChangelogButton';
import { CHANGELOG, CURRENT_VERSION, PROJECT_GITHUB_URL } from '@/lib/changelog';

// 已读版本存在服务端 /api/ui-prefs：用内存里的一份假偏好代替。
const SEEN_KEY = 'changelog-seen';
let prefs: Record<string, unknown> = {};

beforeEach(() => {
  prefs = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/ui-prefs') return new Response(JSON.stringify({ prefs }));
    if (url.startsWith('/api/ui-prefs/') && init?.method === 'PUT') {
      prefs = { ...prefs, [decodeURIComponent(url.slice('/api/ui-prefs/'.length))]: JSON.parse(String(init.body)).value };
      return new Response(JSON.stringify({ prefs }));
    }
    return new Response(JSON.stringify({ announcements: [] }));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChangelogButton', () => {
  it('首次使用：显示版本，不弹面板、不亮圆点，并静默记下当前版本；仓库入口收在面板标题栏', async () => {
    render(<ChangelogButton />);
    expect(screen.getByTestId('changelog-trigger')).toHaveTextContent(`v${CURRENT_VERSION}`);
    expect(screen.queryByRole('link', { name: 'GitHub 项目仓库（新标签页打开）' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(prefs[SEEN_KEY]).toBe(CURRENT_VERSION));
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    const github = within(screen.getByTestId('changelog-panel')).getByRole('link', { name: 'GitHub 项目仓库（新标签页打开）' });
    expect(github).toHaveAttribute('href', PROJECT_GITHUB_URL);
    expect(github).toHaveAttribute('target', '_blank');
    expect(github).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('读过旧版本后升级：只亮圆点，不自动展开，也不提前标记已读', async () => {
    prefs = { [SEEN_KEY]: '0.0.1' };
    render(<ChangelogButton />);
    expect(await screen.findByTestId('changelog-unread-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
    expect(prefs[SEEN_KEY]).toBe('0.0.1');
  });

  it('只有主动打开才记为已读，重新进入时不再亮圆点', async () => {
    prefs = { [SEEN_KEY]: '0.0.1' };
    const { unmount } = render(<ChangelogButton />);
    await screen.findByTestId('changelog-unread-dot');
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    await waitFor(() => expect(prefs[SEEN_KEY]).toBe(CURRENT_VERSION));
    unmount();
    render(<ChangelogButton />);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/ui-prefs')).toHaveLength(2));
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
  });

  it('阅读时圆点消失，从面板外关闭后仍保持已读', async () => {
    prefs = { [SEEN_KEY]: '0.0.1' };
    render(<ChangelogButton />);
    expect(await screen.findByTestId('changelog-unread-dot')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    expect(screen.getByTestId('changelog-panel')).toBeInTheDocument();
    await pointerDownOutside();
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
  });

  it('面板列出全部版本条目', () => {
    render(<ChangelogButton />);
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    const panel = within(screen.getByTestId('changelog-panel'));
    for (const e of CHANGELOG) {
      expect(panel.getByText(`v${e.version}`)).toBeInTheDocument();
      expect(panel.getByText(e.headline)).toBeInTheDocument();
    }
  });

  it('Escape 关闭并把焦点送回触发器', () => {
    render(<ChangelogButton />);
    const trigger = screen.getByTestId('changelog-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('changelog-panel')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('再点一次收起', () => {
    render(<ChangelogButton />);
    const trigger = screen.getByTestId('changelog-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('changelog-panel')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
  });
});
