import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_NAVIGATE_EVENT, desktopNavigatePath, syncShellTheme } from './desktopShell';

declare const process: { cwd: () => string };

const navigate = (path: unknown) => new CustomEvent(DESKTOP_NAVIGATE_EVENT, { detail: { path } });

afterEach(() => {
  delete document.documentElement.dataset.shell;
  delete (window as unknown as { atelierShell?: unknown }).atelierShell;
});

describe('desktop shell bridge', () => {
  it('only follows in-app paths', () => {
    expect(desktopNavigatePath(navigate('/settings/providers'))).toBe('/settings/providers');
    expect(desktopNavigatePath(navigate('//evil.example/x'))).toBeNull();
    expect(desktopNavigatePath(navigate('https://evil.example/'))).toBeNull();
    expect(desktopNavigatePath(navigate(42))).toBeNull();
  });

  it('does nothing in a browser', () => {
    const setTheme = vi.fn();
    (window as unknown as { atelierShell: unknown }).atelierShell = { setTheme };
    syncShellTheme('light');
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('tells the shell the resolved theme inside the desktop app', () => {
    const setTheme = vi.fn();
    (window as unknown as { atelierShell: unknown }).atelierShell = { setTheme };
    document.documentElement.dataset.shell = 'macos';
    syncShellTheme('light');
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('keeps every window-drag rule behind the shell attributes, so browsers never see one', () => {
    const css = readFileSync(`${process.cwd()}/src/styles/tokens.css`, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{[^{}]*app-region[^{}]*\}/g)].map((m) => m[1].trim());
    expect(rules.length).toBeGreaterThan(0);
    for (const selectors of rules) {
      for (const selector of selectors.split(/,(?![^(]*\))/)) {
        expect(selector.trim(), selector).toMatch(/^:root\[data-(titlebar|shell)/);
      }
    }
  });
});
