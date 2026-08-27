import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';

import { CanvasThemeSelector } from './CanvasThemeSelector';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setTheme } from '@/lib/theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('light');
});

function renderSelector() {
  return render(
    <DropdownMenu open>
      <DropdownMenuTrigger>外观</DropdownMenuTrigger>
      <DropdownMenuContent>
        <CanvasThemeSelector />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

it('defaults to dark and switches the shared Atelier theme without project writes', () => {
  renderSelector();

  expect(screen.getByRole('menuitemradio', { name: '深色主题' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemradio', { name: '浅色主题' })).toHaveAttribute('aria-checked', 'false');

  fireEvent.click(screen.getByRole('menuitemradio', { name: '浅色主题' }));
  expect(document.documentElement).toHaveClass('light');
  expect(window.localStorage.getItem('atelier:theme')).toBe('light');
  expect(screen.getByRole('menuitemradio', { name: '浅色主题' })).toHaveAttribute('aria-checked', 'true');

  fireEvent.click(screen.getByRole('menuitemradio', { name: '深色主题' }));
  expect(document.documentElement).not.toHaveClass('light');
  expect(window.localStorage.getItem('atelier:theme')).toBe('dark');
});

it('reacts to the shared setter and cross-tab storage changes', () => {
  renderSelector();

  act(() => setTheme('light'));
  expect(screen.getByRole('menuitemradio', { name: '浅色主题' })).toHaveAttribute('aria-checked', 'true');

  window.localStorage.setItem('atelier:theme', 'dark');
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'atelier:theme',
      newValue: 'dark',
    }));
  });
  expect(screen.getByRole('menuitemradio', { name: '深色主题' })).toHaveAttribute('aria-checked', 'true');
  expect(document.documentElement).not.toHaveClass('light');

  act(() => setTheme('light'));
  window.localStorage.clear();
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(screen.getByRole('menuitemradio', { name: '深色主题' })).toHaveAttribute('aria-checked', 'true');
  expect(document.documentElement).not.toHaveClass('light');
});

it('falls back to dark when a cross-tab value is invalid', () => {
  window.localStorage.setItem('atelier:theme', 'light');
  document.documentElement.classList.add('light');
  renderSelector();

  window.localStorage.setItem('atelier:theme', 'sepia');
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'atelier:theme',
      newValue: 'sepia',
    }));
  });

  expect(screen.getByRole('menuitemradio', { name: '深色主题' })).toHaveAttribute('aria-checked', 'true');
  expect(document.documentElement).not.toHaveClass('light');
});
