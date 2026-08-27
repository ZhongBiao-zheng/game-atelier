import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'atelier:theme';
const CHANGE_EVENT = 'atelier:theme-change';

export function loadTheme(): Theme {
  return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
}

function saveTheme(theme: Theme) {
  window.localStorage.setItem(KEY, theme);
}

/** 把主题落到 <html>：浅色挂 .light 类，深色（默认）不挂——token 覆盖见 tokens.css */
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
}

export function setTheme(theme: Theme) {
  saveTheme(theme);
  applyTheme(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribeTheme(onStoreChange: () => void) {
  const handleChange = () => onStoreChange();
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    applyTheme(loadTheme());
    onStoreChange();
  };
  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, loadTheme, () => 'dark');
}
