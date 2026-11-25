import { useSyncExternalStore } from 'react';
import { applyAccent, currentAccentColors } from './accentTheme';
import { syncShellTheme } from './desktopShell';

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
  applyAccent(currentAccentColors(), resolved);
  syncShellTheme(resolved);
}
export function setTheme(theme: ThemePreference) {
  window.localStorage.setItem(KEY, theme);
  transitionTheme(() => applyTheme(theme));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void> } };

/** 深浅色、主题色切换：浏览器支持 View Transition 时整屏 200ms 交叉淡入（tokens.css 的 ::view-transition 规则）；
 *  不支持或系统要求减弱动态效果时一次到位。两种情况下切换那一帧都关掉元素自己的 transition——
 *  否则带 transition-colors 的按钮慢慢变色、其余瞬切，同一屏新旧主题混着出现。 */
export function transitionTheme(update: () => void | Promise<void>) {
  const root = document.documentElement;
  const reduced = typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = (document as ViewTransitionDocument).startViewTransition;
  root.setAttribute('data-theme-switching', '');
  const settle = () => requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute('data-theme-switching')));
  if (start && !reduced) {
    void start.call(document, update).finished.finally(settle);
    return;
  }
  const pending = update();
  if (pending) void pending.finally(settle);
  else settle();
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
