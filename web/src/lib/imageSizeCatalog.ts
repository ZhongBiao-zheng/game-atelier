import catalog from '../../../src/character_workflow/image_size_catalog.json';
import { normalizedModelId } from './modelFamily';
import type { Resolution } from './studioSize';

export interface ImageSizeOptions {
  ratios: string[];
  resolutions: Resolution[];
}

/** Sizing only: do not infer reference limits, quality or transport from Gemini aliases. */
export function isNanoImageSizeModel(model?: string | null): boolean {
  const id = normalizedModelId(model).replace(/\./g, '-');
  return id.includes('nano-banana') || /^gemini-.*-image(?:-|$)/.test(id);
}

export function imageSizeOptions(model?: string | null, provider?: string | null, baseUrl?: string | null): ImageSizeOptions {
  if (provider === 'openrouter') {
    const options = (catalog.openrouter as Record<string, ImageSizeOptions>)[model ?? ''];
    return options ?? { ratios: catalog.legacy_ratios, resolutions: [] };
  }
  let host = '';
  try { host = new URL(baseUrl ?? '').hostname.toLowerCase(); } catch { /* Unconfigured channel. */ }
  const hk = host === 'openai-hk.com' || host.endsWith('.openai-hk.com');
  return { ratios: hk && isNanoImageSizeModel(model) ? catalog.hk_nano_ratios : catalog.common_ratios, resolutions: [] };
}
