import { clamp } from './imageAnnotation';

export type Rgba = [number, number, number, number];
export function parseColor(value: string): Rgba | null {
  const hex = value.trim().replace(/^#/, '');
  if (!/^([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null;
  const expanded = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
  return [parseInt(expanded.slice(0, 2), 16), parseInt(expanded.slice(2, 4), 16), parseInt(expanded.slice(4, 6), 16), expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1];
}
export function colorHex([r, g, b, a]: Rgba) {
  return `#${[r, g, b, a * 255].map(c => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}
export function toHsv([r, g, b]: Rgba): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max * 100 : 0, max * 100];
}
export function fromHsv(h: number, s: number, v: number, alpha: number): Rgba {
  s /= 100; v /= 100;
  const channel = (n: number) => { const k = (n + h / 60) % 6; return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))); };
  return [channel(5), channel(3), channel(1), alpha];
}

export const COLOR_PRESETS_KEY = 'atelier:annotation-colors';
