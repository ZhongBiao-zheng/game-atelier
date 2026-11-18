import { useSyncExternalStore } from 'react';
import { ACCENT_PRESETS, type AccentColors, type AccentPreset } from './accentPresets';
import { getAccentThemes, saveAccentThemes } from '@/api/accentThemes';
import { localConnection } from '@/api/connection';
import {
  ACCENT_USER_THEME_MAX, type AccentBuiltinOverride, type AccentThemes, type AccentThemesBody, type AccentUserTheme,
} from '@/schema/accentThemes';

/** 客户端缓存：服务端 `.config/accent-themes.json` 的镜像，只为首帧不闪默认色；以服务端为准。 */
export interface AccentDoc extends AccentThemesBody { revision: number }
export interface AccentThemeView {
  id: string;
  name: string;
  builtin: boolean;
  /** 内置主题被改过颜色或名称 */
  edited: boolean;
  colors: AccentColors;
}

const KEY = 'atelier:accent';
const CHANGE_EVENT = 'atelier:accent-change';
const COLOR_KEYS = ['primary', 'brand2', 'brand3', 'brand4'] as const;
const BUILTIN_IDS = new Set<string>(ACCENT_PRESETS.map(preset => preset.id));
export const DEFAULT_ACCENT: AccentDoc = { revision: 0, active: 'lime', overrides: {}, custom: [] };
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
const isColors = (value: unknown): value is AccentColors =>
  !!value && typeof value === 'object' && COLOR_KEYS.every(key => isHexColor((value as Record<string, unknown>)[key]));
export const pickColors = (value: AccentColors): AccentColors =>
  ({ primary: value.primary, brand2: value.brand2, brand3: value.brand3, brand4: value.brand4 });
export const sameColors = (a: AccentColors, b: AccentColors) =>
  COLOR_KEYS.every(key => a[key].toLowerCase() === b[key].toLowerCase());

const LEGACY_NAME = '自定义';
/** 旧版「自定义颜色」（无名称、不进网格）的 id 由颜色决定：同一份旧缓存每次读出同一个主题。 */
const legacyTheme = (colors: AccentColors): AccentUserTheme =>
  ({ id: `u-${COLOR_KEYS.map(key => colors[key].slice(1).toLowerCase()).join('')}`, name: LEGACY_NAME, ...pickColors(colors) });

function parseDoc(value: unknown): AccentDoc | null {
  if (!value || typeof value !== 'object') return null;
  const doc = value as Partial<AccentDoc>;
  if (typeof doc.revision !== 'number' || typeof doc.active !== 'string' || !Array.isArray(doc.custom)
    || !doc.overrides || typeof doc.overrides !== 'object') return null;
  const custom = doc.custom.filter((theme): theme is AccentUserTheme =>
    isColors(theme) && typeof theme.id === 'string' && typeof theme.name === 'string');
  const overrides = Object.fromEntries(Object.entries(doc.overrides)
    .filter(([id, value]) => BUILTIN_IDS.has(id) && isColors(value))
    .map(([id, value]) => {
      const { name } = value as AccentBuiltinOverride;
      return [id, { ...pickColors(value as AccentColors), ...(typeof name === 'string' && name ? { name } : {}) }];
    }));
  const active = BUILTIN_IDS.has(doc.active) || custom.some(theme => theme.id === doc.active) ? doc.active : 'lime';
  return { revision: doc.revision, active, overrides, custom: custom.map(theme => ({ id: theme.id, name: theme.name, ...pickColors(theme) })) };
}

interface CacheRead { doc: AccentDoc; legacy: AccentColors | null }
let cachedRaw: string | null | undefined;
let cachedRead: CacheRead = { doc: DEFAULT_ACCENT, legacy: null };

function readCache(): CacheRead {
  let raw: string | null;
  try { raw = window.localStorage.getItem(KEY); } catch { return { doc: DEFAULT_ACCENT, legacy: null }; }
  if (raw === cachedRaw) return cachedRead;
  cachedRaw = raw;
  cachedRead = { doc: DEFAULT_ACCENT, legacy: null };
  try {
    const value = JSON.parse(raw ?? 'null');
    const doc = parseDoc(value?.doc);
    if (doc) cachedRead = { doc, legacy: null };
    else if (value && BUILTIN_IDS.has(value.preset)) cachedRead = { doc: { ...DEFAULT_ACCENT, active: value.preset }, legacy: null };
    else if (isColors(value?.custom)) {
      const theme = legacyTheme(value.custom);
      cachedRead = { doc: { ...DEFAULT_ACCENT, active: theme.id, custom: [theme] }, legacy: pickColors(value.custom) };
    }
  } catch { /* 无效缓存回到默认主题，服务端同步后覆盖。 */ }
  return cachedRead;
}

export function loadAccent(): AccentDoc {
  return readCache().doc;
}

export function accentThemes(doc: AccentDoc): AccentThemeView[] {
  return [
    ...ACCENT_PRESETS.map(preset => {
      const override = doc.overrides[preset.id];
      return { id: preset.id, name: override?.name || preset.name, builtin: true, edited: !!override,
        colors: pickColors(override ?? preset) };
    }),
    ...doc.custom.map(theme => ({ id: theme.id, name: theme.name, builtin: false, edited: false, colors: pickColors(theme) })),
  ];
}
export function activeTheme(doc: AccentDoc): AccentThemeView {
  const themes = accentThemes(doc);
  return themes.find(theme => theme.id === doc.active) ?? themes[0];
}
export const activeColors = (doc: AccentDoc) => activeTheme(doc).colors;
export const builtinColors = (id: AccentPreset) => pickColors(ACCENT_PRESETS.find(preset => preset.id === id)!);
/** 内置主题的改动：名称与颜色都回到默认时不留覆盖项；value 为 null 即恢复默认。 */
export function withBuiltinOverride(overrides: AccentDoc['overrides'], id: AccentPreset,
  value: { name: string; colors: AccentColors } | null): AccentDoc['overrides'] {
  const { [id]: _previous, ...rest } = overrides;
  if (!value) return rest;
  const preset = ACCENT_PRESETS.find(item => item.id === id)!;
  const renamed = value.name !== preset.name;
  if (!renamed && sameColors(value.colors, pickColors(preset))) return rest;
  return { ...rest, [id]: { ...pickColors(value.colors), ...(renamed ? { name: value.name } : {}) } };
}

/** 名称比较去首尾空白、忽略大小写；内置与用户主题共用一个命名空间。 */
export const normalizeThemeName = (name: string) => name.trim().toLocaleLowerCase();
export function themeNameTaken(doc: AccentDoc, name: string, exceptId?: string) {
  const key = normalizeThemeName(name);
  return accentThemes(doc).some(theme => theme.id !== exceptId && normalizeThemeName(theme.name) === key);
}
export function uniqueThemeName(doc: AccentDoc, base: string) {
  for (let index = 1; ; index++) {
    const name = index === 1 ? base : `${base} ${index}`;
    if (!themeNameTaken(doc, name)) return name;
  }
}
export function newThemeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `u-${[...bytes].map(byte => byte.toString(36).padStart(2, '0').slice(-2)).join('')}`;
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
/** 深色主题按对比度选黑或白；浅色主题主色已压暗到对浅色卡片 3:1，按钮内容一律用白色（2026-11-16 飙哥定）。 */
export function primaryForeground(hex: string, mode: 'dark' | 'light' = 'dark') {
  if (mode === 'light') return '#FFFFFF';
  const value = accentLuminance(hex, mode);
  return ratio(value, luminance(linearRgb('#0A0A0B'))) >= ratio(value, 1) ? '#0A0A0B' : '#FFFFFF';
}
export function accentCardContrast(hex: string, mode: 'dark' | 'light') {
  return ratio(accentLuminance(hex, mode), luminance(linearRgb(mode === 'dark' ? '#18181B' : '#FAFAFA')));
}
export function applyAccent(colors: AccentColors, mode: 'dark' | 'light') {
  const style = document.documentElement.style;
  const color = (value: string) => mode === 'light' ? lightAccentColor(value) : value;
  style.setProperty('--primary', color(colors.primary));
  style.setProperty('--ring', color(colors.primary));
  style.setProperty('--primary-foreground', primaryForeground(colors.primary, mode));
  for (const [key, token] of [['brand2', '--brand-2'], ['brand3', '--brand-3'], ['brand4', '--brand-4']] as const) {
    style.setProperty(token, color(colors[key]));
  }
}
const currentMode = () => document.documentElement.classList.contains('light') ? 'light' : 'dark';

/** 编辑中的草稿只预览、不保存；null 回到已保存的颜色。 */
let preview: AccentColors | null = null;
export function currentAccentColors(): AccentColors {
  return preview ?? activeColors(loadAccent());
}
export function previewAccent(colors: AccentColors | null) {
  preview = colors;
  applyAccent(currentAccentColors(), currentMode());
}

function writeAccent(doc: AccentDoc) {
  try { window.localStorage.setItem(KEY, JSON.stringify({ doc })); } catch { /* 缓存只服务首帧，写不进不影响服务端。 */ }
  applyAccent(currentAccentColors(), currentMode());
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
const fromRemote = (remote: AccentThemes): AccentDoc =>
  ({ revision: remote.revision, active: remote.active, overrides: remote.overrides, custom: remote.custom });

/** 读服务端，并把只存在于本机缓存的选择迁移上去：
 *  - 服务端从未保存（revision 0）：本机缓存（含旧版预设 / 自定义颜色）整份写上去；
 *  - 服务端已有：旧版「自定义颜色」追加成一个用户主题（已有同色主题则复用）并选中它（2026-11-18 飙哥定）。 */
export async function syncAccentThemes(): Promise<AccentDoc> {
  return enqueue(async () => {
    const remote = fromRemote(await getAccentThemes());
    const { doc: local, legacy } = readCache();
    let next = remote;
    if (remote.revision === 0 && JSON.stringify(local) !== JSON.stringify(DEFAULT_ACCENT)) {
      next = fromRemote(await saveAccentThemes(0, local));
    } else if (legacy) {
      const existing = remote.custom.find(theme => sameColors(theme, legacy));
      const theme = existing ?? { ...legacyTheme(legacy), name: uniqueThemeName(remote, LEGACY_NAME) };
      const custom = existing ? remote.custom : [...remote.custom, theme];
      if (custom.length <= ACCENT_USER_THEME_MAX) {
        next = fromRemote(await saveAccentThemes(remote.revision, { ...remote, active: theme.id, custom }));
      }
    }
    writeAccent(next);
    return next;
  });
}

/** 每次本机连接进入就绪（首次连上、重连、接管编辑）都与服务端对一次：桌面版与浏览器可能各自改过。 */
export function startAccentSync() {
  let wasReady = false;
  const check = () => {
    const ready = localConnection.getSnapshot().phase === 'ready';
    if (ready && !wasReady) syncAccentThemes().catch(error => console.warn('主题色同步失败', error));
    wasReady = ready;
  };
  check();
  return localConnection.subscribe(check);
}

/** 先落本机再写服务端；失败回滚到改动前。写入串行，revision 始终取上一笔的结果。 */
export function updateAccentThemes(change: (doc: AccentDoc) => AccentThemesBody): Promise<AccentDoc> {
  return enqueue(async () => {
    const before = loadAccent();
    const body = change(before);
    writeAccent({ ...body, revision: before.revision });
    try {
      const saved = fromRemote(await saveAccentThemes(before.revision, body));
      writeAccent(saved);
      return saved;
    } catch (error) {
      writeAccent(before);
      throw error;
    }
  });
}
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
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
  return useSyncExternalStore(subscribe, loadAccent, () => DEFAULT_ACCENT);
}
