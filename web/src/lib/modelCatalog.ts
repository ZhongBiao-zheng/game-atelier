import { normalizedModelId } from './modelFamily';

export type ModelBrand = 'openai' | 'gemini' | 'bytedance' | 'midjourney' | 'flux' | 'kling' | 'minimax' | 'alibaba';
interface CatalogEntry { key: string; brand: ModelBrand; description: string; match: RegExp }
// Order is display popularity only; it never changes automatic routing priority.
const catalog: CatalogEntry[] = [
  { key: 'gpt-image-2.5-sunburst', brand: 'openai', description: 'Top quality with tight control across edits.', match: /^gpt-image-2\.5-sunburst$/ },
  { key: 'gpt-image-2.5-flare', brand: 'openai', description: 'Fast default. Better than GPT Image 2 at half the latency.', match: /^gpt-image-2\.5-flare$/ },
  { key: 'gpt-image-2.5', brand: 'openai', description: "OpenAI's latest image model.", match: /^gpt-image-2\.5$/ },
  { key: 'gpt-image-2', brand: 'openai', description: 'Reliable all-rounder with strong text rendering.', match: /^gpt-image-2$/ },
  { key: 'nano-banana-2.1', brand: 'gemini', description: 'Flash-speed Gemini model, better text and consistency.', match: /^(gemini-)?nano-banana-2\.1$/ },
  { key: 'nano-banana-pro', brand: 'gemini', description: "Gemini's pro model for detailed, high-fidelity images.", match: /^(nano-banana(-pro)?|gemini-3-pro-image)$/ },
  { key: 'nano-banana-2', brand: 'gemini', description: 'Fast, low-cost Gemini generation and editing.', match: /^(nano-banana-2|gemini-3\.1-flash-image)$/ },
  { key: 'seedream-5.0-pro', brand: 'bytedance', description: 'ByteDance flagship for design, layouts and precise edits.', match: /^(doubao-)?seedream-5[.-]0-pro(-\d+)?$/ },
  { key: 'seedream-5.0-lite', brand: 'bytedance', description: 'Lighter, faster Seedream 5.0.', match: /^(doubao-)?seedream-5[.-]0(-lite)?(-\d+)?$/ },
  { key: 'midjourney', brand: 'midjourney', description: 'Distinctive artistic styles and aesthetics.', match: /^(mj-|midjourney|niji)/ },
  { key: 'flux-3-image', brand: 'flux', description: "Black Forest Labs' latest photoreal model.", match: /^flux[.-]3-image$/ },
  { key: 'flux-2-pro', brand: 'flux', description: 'Sharp photoreal detail and prompt fidelity.', match: /^flux[.-]2-pro$/ },
  { key: 'seedream-4.5', brand: 'bytedance', description: 'Previous Seedream with strong photorealism.', match: /^(doubao-)?seedream-4[.-]5(-\d+)?$/ },
  { key: 'seedance-2.5', brand: 'bytedance', description: 'Multi-shot video with native audio and rich references.', match: /^(doubao-)?seedance-2[.-]5(-\d+)?$/ },
  { key: 'seedance-2.0', brand: 'bytedance', description: "ByteDance's reference-driven video model.", match: /^(doubao-)?seedance-2[.-]0(-\d+)?$/ },
  { key: 'seedance-2.0-fast', brand: 'bytedance', description: 'Quicker, cheaper Seedance 2.0.', match: /^(doubao-)?seedance-2[.-]0-fast(-\d+)?$/ },
  { key: 'veo-3.1', brand: 'gemini', description: "Google's cinematic video with sound.", match: /^veo-3\.1(-.*)?$/ },
  { key: 'sora-2-pro', brand: 'openai', description: "OpenAI's high-fidelity video with audio.", match: /^sora-2-pro$/ },
  { key: 'kling-3.0', brand: 'kling', description: 'Realistic motion, up to 4K output.', match: /^kling-v?3[.-]0(-.*)?$/ },
  { key: 'minimax-h3', brand: 'minimax', description: 'Near top-tier quality at a low per-second price.', match: /^minimax-h3$/ },
  { key: 'happyhorse-1.1', brand: 'alibaba', description: 'Alibaba video from text, image or references.', match: /^happyhorse-1\.1(-.*)?$/ },
  { key: 'seedance-2.0-mini', brand: 'bytedance', description: 'Lightweight Seedance for quick drafts.', match: /^(doubao-)?seedance-2[.-]0-mini(-\d+)?$/ },
  { key: 'happyhorse-1.0', brand: 'alibaba', description: 'Earlier HappyHorse release.', match: /^happyhorse-1\.0(-.*)?$/ },
];

function identity(id: string) {
  // Video automatic route ids can carry a protocol prefix; :save is a suffix.
  return normalizedModelId(id).replace(/^[^:]+:(?=.+:|(?:seedance|veo|sora|kling|happyhorse|minimax|doubao)-)/, '');
}
function baseId(id: string) { return identity(id).replace(/(?:(?:-(?:2k|4k|hd|vip))|:save)+$/g, ''); }
export function modelCatalog(id: string) {
  const rank = catalog.findIndex(entry => entry.match.test(baseId(id)));
  return rank < 0 ? undefined : { ...catalog[rank], rank };
}
function variantRank(id: string) {
  const value = identity(id);
  const size = /-2k/.test(value) ? 1 : /-4k/.test(value) ? 2 : /-hd/.test(value) ? 3 : 0;
  return size * 4 + (value.includes(':save') ? 1 : 0) + (value.endsWith('-vip') ? 2 : 0);
}
export function sortModels<T extends { id: string }>(models: readonly T[]): T[] {
  return [...models].sort((a, b) => {
    const first = modelCatalog(a.id), second = modelCatalog(b.id);
    return (first?.rank ?? Infinity) - (second?.rank ?? Infinity)
      || (first && second ? variantRank(a.id) - variantRank(b.id) : 0);
  });
}
