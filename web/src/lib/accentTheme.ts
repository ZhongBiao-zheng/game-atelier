import { useSyncExternalStore } from 'react';
import { ACCENT_PRESETS, type AccentColors, type AccentPreset } from './accentPresets';

export type AccentState = { preset: AccentPreset } | { custom: AccentColors };
const KEY = 'atelier:accent';
const CHANGE_EVENT = 'atelier:accent-change';
const DEFAULT: AccentState = { preset: 'lime' };
const COLOR_KEYS = ['primary', 'brand2', 'brand3', 'brand4'] as const;
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
let cachedRaw: string | null | undefined;
let cachedState: AccentState = DEFAULT;

export function loadAccent(): AccentState {
  let raw: string | null;
  try { raw = window.localStorage.getItem(KEY); } catch { return DEFAULT; }
  if (raw === cachedRaw) return cachedState;
  cachedRaw = raw;
  cachedState = DEFAULT;
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value && ACCENT_PRESETS.some(preset => preset.id === value.preset)) {
      cachedState = { preset: value.preset };
    } else if (value?.custom && COLOR_KEYS.every(key => isHexColor(value.custom[key]))) {
      cachedState = { custom: Object.fromEntries(COLOR_KEYS.map(key => [key, value.custom[key]])) as unknown as AccentColors };
    }
  } catch { /* 无效存储回到默认主题。 */ }
  return cachedState;
}

export function accentColors(state: AccentState): AccentColors {
  return 'custom' in state ? state.custom : ACCENT_PRESETS.find(preset => preset.id === state.preset)!;
}

function linearRgb(hex: string): number[] {
  return [1, 3, 5].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
}
const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
export const contrastRatio = (a: string, b: string) => ratio(luminance(linearRgb(a)), luminance(linearRgb(b)));

// OKLab 的标准矩阵：浅色模式保持 C/h，只压低 L。
function oklab(hex: string) {
  const [r, g, b] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s };
}
function labLuminance(L: number, a: number, b: number) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return luminance([
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(channel => Math.max(0, Math.min(1, channel))));
}
const LIGHT_CARD = luminance(linearRgb('#FAFAFA'));
// 浅色只压到「对浅色卡片刚好 3:1」为止：一刀切到 0.5 会把青柠这类高明度色压成橄榄绿。
const LIGHT_MIN_CONTRAST = 3;
function lightL(hex: string) {
  const { L, a, b } = oklab(hex);
  for (let next = Math.round(L * 100) / 100; next > 0.2; next = Math.round((next - 0.01) * 100) / 100) {
    if (ratio(labLuminance(next, a, b), LIGHT_CARD) >= LIGHT_MIN_CONTRAST) return next;
  }
  return 0.2;
}
export function lightAccentColor(hex: string): string {
  const { a, b } = oklab(hex);
  return `oklch(${lightL(hex)} ${Math.hypot(a, b)} ${Math.atan2(b, a) * 180 / Math.PI})`;
}
function accentLuminance(hex: string, mode: 'dark' | 'light') {
  if (mode === 'dark') return luminance(linearRgb(hex));
  const { a, b } = oklab(hex);
  return labLuminance(lightL(hex), a, b);
}
export function primaryForeground(hex: string, mode: 'dark' | 'light' = 'dark') {
  const value = accentLuminance(hex, mode);
  return ratio(value, luminance(linearRgb('#0A0A0B'))) >= ratio(value, 1) ? '#0A0A0B' : '#FFFFFF';
}
export function accentCardContrast(hex: string, mode: 'dark' | 'light') {
  return ratio(accentLuminance(hex, mode), luminance(linearRgb(mode === 'dark' ? '#18181B' : '#FAFAFA')));
}
export function applyAccent(state: AccentState, mode: 'dark' | 'light') {
  const colors = accentColors(state);
  const style = document.documentElement.style;
  const color = (value: string) => mode === 'light' ? lightAccentColor(value) : value;
  style.setProperty('--primary', color(colors.primary));
  style.setProperty('--ring', color(colors.primary));
  style.setProperty('--primary-foreground', primaryForeground(colors.primary, mode));
  for (const [key, token] of [['brand2', '--brand-2'], ['brand3', '--brand-3'], ['brand4', '--brand-4']] as const) {
    style.setProperty(token, color(colors[key]));
  }
}
export function setAccent(state: AccentState) {
  window.localStorage.setItem(KEY, JSON.stringify(state));
  applyAccent(loadAccent(), document.documentElement.classList.contains('light') ? 'light' : 'dark');
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
function subscribe(onChange: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) onChange(); };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', storage);
  };
}
export function useAccent() {
  return useSyncExternalStore(subscribe, loadAccent, () => DEFAULT);
}
