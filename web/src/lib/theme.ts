import { useSyncExternalStore } from 'react';
import { applyAccent, loadAccent } from './accentTheme';

export type Theme = 'dark' | 'light';
export type ThemePreference = Theme | 'system';
const KEY = 'atelier:theme';
const CHANGE_EVENT = 'atelier:theme-change';
const systemMedia = () => window.matchMedia('(prefers-color-scheme: light)');

export function loadTheme(): ThemePreference {
  const value = window.localStorage.getItem(KEY);
  return value === 'light' || value === 'system' ? value : 'dark';
}
export function resolveTheme(theme: ThemePreference): Theme {
  return theme === 'system' ? (systemMedia().matches ? 'light' : 'dark') : theme;
}
export function applyTheme(theme: ThemePreference) {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('light', resolved === 'light');
  applyAccent(loadAccent(), resolved);
}
export function setTheme(theme: ThemePreference) {
  window.localStorage.setItem(KEY, theme);
  applyTheme(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
function subscribeTheme(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    applyTheme(loadTheme());
    onStoreChange();
  };
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', handleStorage);
  };
}
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, () => resolveTheme(loadTheme()), () => 'dark');
}
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, loadTheme, () => 'dark');
}
/** 全站同步独立于设置页是否挂载。 */
export function startThemeSync() {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY || event.key === 'atelier:accent') applyTheme(loadTheme());
  };
  const media = systemMedia();
  const systemChange = () => {
    if (loadTheme() !== 'system') return;
    applyTheme('system');
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  window.addEventListener('storage', storage);
  media.addEventListener('change', systemChange);
  return () => {
    window.removeEventListener('storage', storage);
    media.removeEventListener('change', systemChange);
  };
}
