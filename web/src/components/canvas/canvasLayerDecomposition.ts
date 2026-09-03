import { modelModality, type KeyView } from '@/api/keys';
import type { CanvasModelChoice } from '@/components/canvas/CanvasGenerationControls';

export function layerDecompositionModelChoices(keys: KeyView[]): CanvasModelChoice[] {
  return keys.flatMap(key => key.models
    .filter(model => {
      const normalized = model.id.toLowerCase().replace(/[._]/g, '-');
      const inferredArk = !model.protocol && (
        key.provider === 'tokendance'
        || key.base_url?.toLowerCase().includes('tokendance.space')
      );
      const arkCompatible = key.provider === 'seedream'
        || model.protocol === 'ark'
        || inferredArk;
      return modelModality(model, key) === 'image'
        && normalized.includes('seedream-5-0-pro')
        && arkCompatible;
    })
    .map(model => ({ key, model })));
}
