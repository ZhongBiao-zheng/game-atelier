import type { JobParams } from '@/schema/jobs';
import { imageControlCaps } from './imageControlCaps';
import { imageFamily } from './modelFamily';
import { normalizeImagePixelSize, studioSizeFor, type Resolution } from './studioSize';

export function imageSizeMode(params: JobParams): 'auto' | 'ratio' | 'custom' {
  return params.size_mode ?? (params.size === 'auto' ? 'auto' : 'ratio');
}

/** Missing sizing fields mean a fresh draft, not a saved ratio selection. */
export function hasImageSizeSelection(params: JobParams): boolean {
  return [params.size_mode, params.size, params.ratio, params.resolution, params.custom_size]
    .some(value => value != null);
}

export function imageSizeSummary(params: JobParams): string {
  const mode = imageSizeMode(params);
  return mode === 'auto' ? 'AUTO' : mode === 'custom'
    ? (params.size || params.custom_size || '').replace('x', '×') : params.ratio || '1:1';
}

export function imageSizeError(params: JobParams, model?: string): string | null {
  if (imageSizeMode(params) !== 'custom') return null;
  const match = /^(\d+)x(\d+)$/.exec(params.size ?? '');
  if (match && imageFamily(model) === 'gpt-image') {
    const w = Number(match[1]), h = Number(match[2]);
    if (w > 0 && h > 0 && Math.max(w / h, h / w) > 3) return '该模型的长短边比例不能超过 3:1';
  }
  return match && match.slice(1).every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 100_000)
    ? null : '宽高请输入 1–100000 的整数';
}

/** Validate and prepare the effective rule before uploads or paid submission. */
export function prepareImageSizeSubmission(
  model: string, provider: string | null | undefined, baseUrl: string | null | undefined,
  draft: JobParams,
): { params: JobParams; error?: never } | { params?: never; error: string } {
  const error = imageSizeError(draft, model);
  if (error) return { error };
  const params = normalizeImageSizeParams(model, provider, baseUrl, draft);
  const mode = imageSizeMode(params);
  if (hasImageSizeSelection(draft) && mode !== imageSizeMode(draft)) return { error: '当前模型不支持原尺寸模式，请重新选择' };
  if (mode === 'custom' && params.size) params.size = normalizeImagePixelSize(params.size, model, baseUrl);
  if (mode !== 'ratio') {
    delete params.ratio;
    delete params.resolution;
  }
  delete params.custom_size;
  return { params };
}

/** Drafts retain inactive choices; the server freezes only the active sizing rule. */
export function normalizeImageSizeParams(
  model: string, provider: string | null | undefined, baseUrl: string | null | undefined,
  current: JobParams,
): JobParams {
  const caps = imageControlCaps(model, provider, baseUrl);
  const { size: _size, resolution: _resolution, ...retained } = current;
  let mode = !hasImageSizeSelection(current) && caps.showAutoSize ? 'auto' as const : imageSizeMode(current);
  if ((mode === 'auto' && !caps.showAutoSize) || (mode === 'custom' && !caps.showCustomSize)) mode = 'ratio';
  const ratio = caps.ratios.includes(current.ratio ?? '') ? current.ratio! : caps.ratios[0];
  const resolution = caps.resolutions.includes(current.resolution as Resolution)
    ? current.resolution as Resolution : caps.resolutions[0] ?? '2K';
  const params: JobParams = { ...retained, size_mode: mode, ratio };
  if (caps.showResolution && (provider !== 'openrouter' || caps.resolutions.includes(current.resolution as Resolution))) params.resolution = resolution;
  if (mode === 'auto') return { ...params, size: 'auto' };
  if (mode === 'custom') {
    // Preserve in-progress input. Blur/submit normalize legal pixels, never each keystroke.
    const size = current.size ?? current.custom_size ?? studioSizeFor(ratio, resolution, model);
    return { ...params, size, custom_size: size };
  }
  if (caps.sizeKind === 'ratio') params.size = ratio;
  else if (caps.sizeKind === 'pixels') {
    const size = /^\d+x\d+$/.test(current.size ?? '') && imageSizeMode(current) === 'ratio'
      ? current.size! : studioSizeFor(ratio, resolution, model);
    params.size = normalizeImagePixelSize(size, model, baseUrl);
  }
  return params;
}
