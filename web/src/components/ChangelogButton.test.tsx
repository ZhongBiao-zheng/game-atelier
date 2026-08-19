import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ChangelogButton } from './ChangelogButton';
import { CHANGELOG, CURRENT_VERSION } from '@/lib/changelog';

const SEEN_KEY = 'atelier:changelog-seen';

afterEach(() => {
  window.localStorage.removeItem(SEEN_KEY);
});

describe('ChangelogButton', () => {
  it('首次使用：不弹面板、不亮红点，并静默记下当前版本', () => {
    render(<ChangelogButton />);
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(CURRENT_VERSION);
  });

  it('读过旧版本后升级：亮红点并自动展开一次', () => {
    window.localStorage.setItem(SEEN_KEY, '0.0.1');
    render(<ChangelogButton />);
    expect(screen.getByTestId('changelog-unread-dot')).toBeInTheDocument();
    expect(screen.getByTestId('changelog-panel')).toBeInTheDocument();
  });

  it('自动展开当场就记为已读 —— 从别处点走也不会下次再弹', () => {
    window.localStorage.setItem(SEEN_KEY, '0.0.1');
    render(<ChangelogButton />);
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(CURRENT_VERSION);
  });

  it('关闭后红点消失', () => {
    window.localStorage.setItem(SEEN_KEY, '0.0.1');
    render(<ChangelogButton />);
    expect(screen.getByTestId('changelog-unread-dot')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    expect(screen.queryByTestId('changelog-unread-dot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('changelog-panel')).not.toBeInTheDocument();
  });

  it('面板列出全部版本条目', () => {
    render(<ChangelogButton />);
    fireEvent.click(screen.getByTestId('changelog-trigger'));
    for (const e of CHANGELOG) {
      expect(screen.getByText(`v${e.version}`)).toBeInTheDocument();
      expect(screen.getByText(e.headline)).toBeInTheDocument();
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
