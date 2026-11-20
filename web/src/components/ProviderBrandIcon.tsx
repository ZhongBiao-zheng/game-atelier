/* Source: LobeHub lobe-icons (Volcengine / OpenRouter), https://github.com/lobehub/lobe-icons
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
import { ICON_PX, ProviderIcon, RouteIcon, WorkflowIcon, type IconSize } from '@/components/ui/icons';
import { providerPresetId } from '@/pages/settings/providerPresets';
import { BrandGlyph, brandOfIcon, type ProviderBrand } from './providerBrands';
import tokendance from '@/assets/providers/tokendance.svg';
import tuzi from '@/assets/providers/tuzi.png';
import openaiHk from '@/assets/providers/openai-hk.png';
import evolink from '@/assets/providers/evolink.svg';

const masks: Record<string, string> = { tokendance, tuzi, 'openai-hk': openaiHk, evolink };
// 预置与按域名识别出的供应商沿用品牌图标；硅基流动的图标在 I1 补上。
const PRESET_BRANDS: Record<string, ProviderBrand> = {
  openai: 'openai', chatgpt: 'openai', anthropic: 'anthropic', seedream: 'volcengine', openrouter: 'openrouter',
  gemini: 'gemini', deepseek: 'deepseek', kimi: 'moonshot', zhipu: 'zhipu', qwen: 'alibaba', siliconflow: 'siliconcloud',
};

/** 名称首字母：拉丁字母转大写，中文取第一个字。 */
export function providerInitial(alias: string | undefined): string {
  const first = Array.from(alias?.trim() ?? '')[0];
  return first ? first.toLocaleUpperCase() : '';
}

/** 显示优先级：用户选的内置品牌 → 预置 / 域名规则 → 名称首字母 → 通用图标。 */
export function ProviderBrandIcon({ provider, size = 'lg' }: {
  provider?: { provider?: string; base_url?: string | null; alias?: string; icon?: string | null } | null;
  size?: IconSize;
}) {
  const px = ICON_PX[size];
  if (provider?.provider === 'auto') return <RouteIcon size={size} className="shrink-0" aria-hidden="true" />;
  const chosen = brandOfIcon(provider?.icon);
  if (chosen) return <BrandGlyph brand={chosen} size={size} />;
  const id = providerPresetId(provider);
  if (id === 'comfyui') return <WorkflowIcon size={size} aria-hidden="true" />;
  const brand = PRESET_BRANDS[id];
  if (brand) return <BrandGlyph brand={brand} size={size} />;
  if (masks[id]) return <span aria-hidden="true" className="shrink-0 bg-current" style={{ width: px, height: px, maskImage: `url("${masks[id]}")`, maskSize: 'contain', maskRepeat: 'no-repeat' }} />;
  const initial = providerInitial(provider?.alias);
  if (initial) {
    return <span aria-hidden="true" data-icon="initial" className="inline-flex shrink-0 select-none items-center justify-center font-medium leading-none" style={{ width: px, height: px, fontSize: Math.round(px * 0.75) }}>{initial}</span>;
  }
  return <ProviderIcon size={size} className="shrink-0" aria-hidden="true" />;
}
