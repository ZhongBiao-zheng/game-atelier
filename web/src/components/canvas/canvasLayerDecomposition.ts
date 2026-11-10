import { modelModality, type KeyView } from '@/api/keys';
import type { CanvasModelChoice } from '@/components/canvas/CanvasGenerationControls';

/** 与后端 openai_image._is_tokendance_gateway 同判据：只看 host，不看路径。 */
function isTokendanceGateway(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl.trim()).host.toLowerCase().includes('tokendance');
  } catch {
    return false;
  }
}

/** 支持图层拆分的模型族（归一化 id 子串）；与后端 openai_image.LAYER_DECOMPOSITION_FAMILIES 同步。 */
export const LAYER_DECOMPOSITION_FAMILIES = ['seedream-5-0-pro', 'seedream-5-0-flash'] as const;

/** 图层拆分模型判据的 TS 版；Python 版是 openai_image.supports_layer_decomposition，改一边必须改另一边。
 *
 * Seedream 5.0 Pro / Flash 且实际走 Ark 协议：火山直连（provider=seedream）、模型已登记 protocol=ark，
 * 或未登记 protocol 但入口是词元跳动网关（后端 resolve_image_protocol 会把 seedream 族解析成 ark）。 */
export function supportsLayerDecomposition(
  key: Pick<KeyView, 'provider' | 'base_url'>,
  model: Pick<KeyView['models'][number], 'id' | 'protocol' | 'via'>,
): boolean {
  if (key.provider === 'atelier') {
    return Boolean(model.via?.length) && model.via!.every(member => supportsLayerDecomposition(
      { provider: member.provider, base_url: member.base_url },
      { id: member.model_id, protocol: member.protocol },
    ));
  }
  const normalized = model.id.toLowerCase().replace(/[._]/g, '-');
  if (!LAYER_DECOMPOSITION_FAMILIES.some(family => normalized.includes(family))) return false;
  if (key.provider === 'seedream') return true;
  const protocol = model.protocol
    ?? ((key.provider === 'tokendance' || isTokendanceGateway(key.base_url)) ? 'ark' : null);
  return protocol === 'ark';
}

export function layerDecompositionModelChoices(keys: KeyView[]): CanvasModelChoice[] {
  return keys.flatMap(key => key.models
    .filter(model => modelModality(model, key) === 'image' && supportsLayerDecomposition(key, model))
    .map(model => ({ key, model })));
}
