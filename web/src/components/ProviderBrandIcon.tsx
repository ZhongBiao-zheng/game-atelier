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
import { Building2 } from 'lucide-react';
import { providerPresetId } from '@/pages/settings/providerPresets';
import { ModelBrandIcon } from './ModelBrandIcon';
import tokendance from '@/assets/providers/tokendance.svg';
import tuzi from '@/assets/providers/tuzi.png';
import openaiHk from '@/assets/providers/openai-hk.png';
import evolink from '@/assets/providers/evolink.png';

const images: Record<string, string> = { tuzi, 'openai-hk': openaiHk, evolink };
const paths = {
  seedream: <><path d="M7.29 5.36L3.148 21.737a.215.215 0 00.203.261h8.29a.214.214 0 00.215-.261L7.7 5.359a.214.214 0 00-.41 0z" fillOpacity=".5"></path><path clipRule="evenodd" d="M4.553 16.18l-1.406 5.558a.214.214 0 00.203.261h2.42-4.551a.214.214 0 01-.214-.26l2.275-8.961a.214.214 0 01.409 0l.864 3.402z"></path><path d="M14.44.15a.214.214 0 00-.41 0L8.366 21.739a.214.214 0 00.214.261H19.9a.214.214 0 00.215-.261L14.44.151z" fillOpacity=".5"></path><path clipRule="evenodd" d="M16.694 22h3.207a.215.215 0 00.214-.262l-1.839-6.993 1.164-4.592a.214.214 0 01.411 0l2.951 11.586a.214.214 0 01-.214.261h-5.894z"></path><path d="M10.278 7.741L6.685 21.736a.214.214 0 00.214.264h7.17a.216.216 0 00.214-.166.216.216 0 000-.098L10.687 7.742a.214.214 0 00-.409 0z"></path></>,
  openrouter: <><path d="M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z"></path></>,
};

export function ProviderBrandIcon({ provider, size = 20 }: {
  provider?: { provider?: string; base_url?: string | null } | null;
  size?: number;
}) {
  const id = providerPresetId(provider);
  if (id === 'openai' || id === 'chatgpt') return <ModelBrandIcon brand="openai" size={size} />;
  if (id === 'seedream' || id === 'openrouter') {
    return <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" className="shrink-0" aria-hidden="true">{paths[id]}</svg>;
  }
  if (id === 'tokendance') return <span aria-hidden="true" className="shrink-0 bg-current" style={{ width: size, height: size, maskImage: `url("${tokendance}")`, maskSize: 'contain', maskRepeat: 'no-repeat' }} />;
  if (images[id]) return <img src={images[id]} width={size} height={size} alt="" aria-hidden="true" className="shrink-0 rounded-sm" />;
  return <Building2 size={size} className="shrink-0" aria-hidden="true" />;
}
