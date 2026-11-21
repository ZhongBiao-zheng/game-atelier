/* Source: @lobehub/icons-static-svg 1.104.0 *-color.svg（assets/brands-color/），https://github.com/lobehub/lobe-icons
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { useBrandIconMode } from '@/lib/brandIconMode';
import { useTheme, type Theme } from '@/lib/theme';

/**
 * 品牌图标「彩色」的唯一判定处：哪些品牌有彩色版、在哪个主题下能用。
 *
 * 量法（scripts/brand_icon_contrast.py）：SVG 里 fill 与渐变 stop-color 出现最多的颜色为主色（currentColor 按黑色），
 * 算它对图标方块底色 --secondary（暗 #26262A、亮 #E9E9EB）的 WCAG 对比度。两种主题同一条规则、同一个阈值：
 * 非文本元素按 3:1，低于它的品牌在该主题下退回单色，另一主题照常彩色（2026-11-21 定）。
 *
 * 不在表里的品牌没有彩色版：anthropic、openai、midjourney、flux、moonshot（lobe-icons 没有彩色版），
 * xai、runway、replicate（同上），以及 tokendance、tuzi、openai-hk、evolink（不在 lobe-icons 里，官网原图许可未找到）。
 */
export const MIN_CONTRAST = 3;

/** 品牌 → 亮底、暗底的实测对比度；是否可用彩色由 usable() 按 MIN_CONTRAST 判出，见 COLOR_TABLE。 */
const CONTRAST: Record<string, Record<Theme, number>> = {
  alibaba: { dark: 4.97, light: 2.5 },
  aws: { dark: 1.39, light: 17.32 },
  azure: { dark: 3.33, light: 3.73 },
  baidu: { dark: 1.89, light: 6.57 },
  bytedance: { dark: 7.32, light: 1.7 },
  deepseek: { dark: 3.48, light: 3.57 },
  doubao: { dark: 2.16, light: 5.76 },
  fal: { dark: 3.36, light: 3.7 },
  gemini: { dark: 5.83, light: 2.13 },
  google: { dark: 4.23, light: 2.94 },
  kling: { dark: 13.6, light: 1.09 },
  minimax: { dark: 3.34, light: 3.72 },
  mistral: { dark: 8.17, light: 1.52 },
  newapi: { dark: 11.01, light: 1.13 },
  openrouter: { dark: 12.75, light: 1.03 },
  siliconcloud: { dark: 2.38, light: 5.23 },
  tencent: { dark: 2.3, light: 5.4 },
  volcengine: { dark: 9.58, light: 1.3 },
  zhipu: { dark: 2.9, light: 4.29 },
};

const FILES = import.meta.glob('../assets/brands-color/*.svg', { eager: true, query: '?url', import: 'default' }) as
  Record<string, string>;
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [path.split('/').pop()!.replace(/\.svg$/, ''), url]));

const usable = (ratio: number) => ratio >= MIN_CONTRAST;

/** 品牌 → 亮底、暗底各自是否可用彩色（对比度一并给出）。 */
export const COLOR_TABLE: Record<string, Record<Theme, { contrast: number; color: boolean }>> = Object.fromEntries(
  Object.entries(CONTRAST).map(([brand, ratio]) => [brand, {
    light: { contrast: ratio.light, color: usable(ratio.light) },
    dark: { contrast: ratio.dark, color: usable(ratio.dark) },
  }]));

/** 这个品牌在这个主题下用彩色版时的地址；没有彩色版或该主题下对比度不足返回 null（用单色）。 */
export function colorBrandSource(brand: string, theme: Theme): string | null {
  const source = SOURCES[brand];
  return source && COLOR_TABLE[brand]?.[theme].color ? source : null;
}

/** 当前设置下该用的彩色版地址；「黑白」或没有可用彩色版时为 null。 */
export function useColorBrandSource(brand: string | undefined): string | null {
  const mode = useBrandIconMode();
  const theme = useTheme();
  return brand && mode === 'color' ? colorBrandSource(brand, theme) : null;
}

/** 测试用：表里的品牌与 assets/brands-color 下的文件一一对应。 */
export const COLOR_BRANDS = Object.keys(CONTRAST);
export const COLOR_FILES = Object.keys(SOURCES);
