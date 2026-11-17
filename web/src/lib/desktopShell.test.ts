import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_NAVIGATE_EVENT, desktopNavigatePath, syncShellTheme } from './desktopShell';

const navigate = (path: unknown) => new CustomEvent(DESKTOP_NAVIGATE_EVENT, { detail: { path } });

afterEach(() => {
  delete document.documentElement.dataset.shell;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('desktop shell bridge', () => {
  it('only follows in-app paths', () => {
    expect(desktopNavigatePath(navigate('/settings/providers'))).toBe('/settings/providers');
    expect(desktopNavigatePath(navigate('//evil.example/x'))).toBeNull();
    expect(desktopNavigatePath(navigate('https://evil.example/'))).toBeNull();
    expect(desktopNavigatePath(navigate(42))).toBeNull();
  });

  it('does nothing in a browser', () => {
    const invoke = vi.fn(() => Promise.resolve());
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
    syncShellTheme('light');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('tells the shell the resolved theme inside the desktop app', () => {
    const invoke = vi.fn(() => Promise.resolve());
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
    document.documentElement.dataset.shell = 'macos';
    syncShellTheme('light');
    expect(invoke).toHaveBeenCalledWith('plugin:window|set_theme', { value: 'light' });
  });
});
