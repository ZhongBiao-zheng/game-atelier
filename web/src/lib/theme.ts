export type Theme = 'dark' | 'light';

const KEY = 'atelier:theme';

export function loadTheme(): Theme {
  return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
}

export function saveTheme(theme: Theme) {
  window.localStorage.setItem(KEY, theme);
}

/** 把主题落到 <html>：浅色挂 .light 类，深色（默认）不挂——token 覆盖见 tokens.css */
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
}
