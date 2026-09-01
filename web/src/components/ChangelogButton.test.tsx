import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ChangelogButton } from './ChangelogButton';
import { CHANGELOG, CURRENT_VERSION, PROJECT_GITHUB_URL } from '@/lib/changelog';

const SEEN_KEY = 'atelier:changelog-seen';

afterEach(() => {
  window.localStorage.removeItem(SEEN_KEY);
});

describe('ChangelogButton', () => {
  it('首次使用：显示版本与 GitHub，不弹面板、不亮圆点，并静默记下当前版本', () => {
    render(<ChangelogButton />);
    expect(screen.getByTestId('changelog-trigger')).toHaveTextContent(`v${CURRENT_VERSION}`);
    const github = screen.getByRole('link', { name: 'GitHub 项目仓库（新标签页打开）' });
    expect(github).toHaveAttribute('href', PROJECT_GITHUB_URL);
    expect(github).toHaveAttribute('target', '_blank');
    expect(github).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(CURRENT_VERSION);
  });

  it('读过旧版本后升级：只亮圆点，不自动展开，也不提前标记已读', () => {
    window.localStorage.setItem(SEEN_KEY, '0.0.1');
    render(<ChangelogButton />);
    expect(screen.getByTestId('changelog-unread-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('0.0.1');
  });

  it('只有主动打开才记为已读，重新进入时不再亮圆点', () => {
    window.localStorage.setItem(SEEN_KEY, '0.0.1');
    const { unmount } = render(<ChangelogButton />);
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(CURRENT_VERSION);
    unmount();
    render(<ChangelogButton />);
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
  });

  it('阅读时圆点消失，从面板外关闭后仍保持已读', () => {
    window.localStorage.setItem(SEEN_KEY, '0.0.1');
    render(<ChangelogButton />);
    expect(screen.getByTestId('changelog-unread-dot')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    expect(screen.getByTestId('changelog-panel')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
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
