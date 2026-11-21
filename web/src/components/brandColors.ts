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
 * 品牌图标「彩色」的唯一判定处：assets/brands-color/ 下有文件的品牌有彩色版，下面名单里的品牌在对应主题下退回单色。
 *
 * 名单是 2026-11-21 管理会话按实际渲染人工判定的：把彩色版放在两种图标方块底色上（--secondary，
 * 亮 #E9E9EB、暗 #26262A），按 18px 与 36px 逐个看，标准是 18px 下图标主体形状能否辨认。
 * 新增彩色品牌时，先在两种方块底色上看过，再决定进不进名单。
 *
 * 没有彩色版（assets/brands-color/ 下没有文件）的品牌：anthropic、openai、midjourney、flux、xai、runway、replicate
 * （lobe-icons 只有单色版），moonshot（lobe 只有 kimi-color，是另一个标志），tokendance、tuzi、openai-hk、evolink
 * （不在 lobe-icons 里，官网原图的许可没找到）。
 */
export const MONO_IN: Record<Theme, readonly string[]> = {
  light: ['openrouter'],     // 青柠色在浅底上看不清
  dark: ['aws', 'baidu'],    // aws 文字近黑色，暗底上只剩一道橙色弧线；baidu 深蓝在暗底上看不清
};

const FILES = import.meta.glob('../assets/brands-color/*.svg', { eager: true, query: '?url', import: 'default' }) as
  Record<string, string>;
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [path.split('/').pop()!.replace(/\.svg$/, ''), url]));

/** 这个品牌在这个主题下用彩色版时的地址；没有彩色版或在该主题的退回名单里返回 null（用单色）。 */
export function colorBrandSource(brand: string, theme: Theme): string | null {
  const source = SOURCES[brand];
  return source && !MONO_IN[theme].includes(brand) ? source : null;
}

/** 当前设置下该用的彩色版地址；「黑白」或没有可用彩色版时为 null。 */
export function useColorBrandSource(brand: string | undefined): string | null {
  const mode = useBrandIconMode();
  const theme = useTheme();
  return brand && mode === 'color' ? colorBrandSource(brand, theme) : null;
}

/** 有彩色版的品牌（assets/brands-color/ 下的文件名）。 */
export const COLOR_BRANDS = Object.keys(SOURCES);
