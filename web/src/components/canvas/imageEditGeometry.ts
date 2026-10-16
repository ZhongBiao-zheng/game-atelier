import type { KeyView } from '@/api/keys';
import { modelModality } from '@/api/keys';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { isEvolinkMidjourney } from '@/lib/modelFamily';
import { normalizeImagePixelSize } from '@/lib/studioSize';
import type { JobParams } from '@/schema/jobs';
import type { CanvasImageEditNode, CanvasContentVersion } from '@/schema/canvas';

export type EditFrame = { width: number; height: number; x: number; y: number };
export type EditPoint = { x: number; y: number };
export type EditTool = 'brush' | 'eraser' | 'rectangle' | 'hand';
export type EditStroke = { tool: Exclude<EditTool, 'hand'>; size: number; points: EditPoint[] };

export function initialEditFrame(width: number, height: number, mode: 'inpaint' | 'outpaint'): EditFrame {
  return mode === 'outpaint' ? presetFrame(width, height, 'original', 1) : { width, height, x: 0, y: 0 };
}

export function savedImageEditError(node: CanvasImageEditNode, source: CanvasContentVersion | undefined,
  keys: readonly KeyView[]): string | null {
  if (source?.kind !== 'image' || !source.width || !source.height) return '编辑源图片不存在。';
  const draft = node.data.generation_draft;
  const key = keys.find(item => item.alias === draft?.alias);
  if (!draft?.model || !key || !key.models.some(model => model.id === draft.model)) return '请先编辑并选择可用模型。';
  const { options } = node.data;
  if (!key.models.some(model => model.id === draft.model && isEditModel(model, key))) return '请选择可用的编辑模型。';
  const mj = isEvolinkMidjourney(draft.model, key.provider);
  if (mj && !draft.prompt.trim()) return '请先填写修改说明。';
  if (options.mode === 'inpaint') {
    return node.data.mask_version_id ? editSize(key, draft.model, source.width, source.height).error
      : '请先编辑并保存需要修改的区域。';
  }
  if (options.mode === 'outpaint') {
    const { width = 0, height = 0, x = -1, y = -1 } = options;
    if (x < 0 || y < 0 || x + source.width > width || y + source.height > height
      || (width === source.width && height === source.height)) return '画框必须向外扩展并完整包含原图';
    return editSize(key, draft.model, width, height).error;
  }
  return null;
}

/** 局部修改 / 扩图目前只开放实测过的型号：GPT Image 2.5 系列、Nano Banana 2 / 2.1、Seedream 5.0 pro（另加 EvoLink MJ）。
 *  与后端 callers/image_edit.py 的 EDIT_MODEL_PATTERN 保持一致。 */
const EDIT_MODEL_PATTERN = /^(gpt-image-2\.5(-[a-z0-9]+)?|(gemini-)?nano-banana-2(\.1)?(-[24]k)?|seedream-5\.0-pro|doubao-seedream-5-0-pro(-\d+)?)$/;

export function isEditModel(model: KeyView['models'][number], key: KeyView) {
  if (isEvolinkMidjourney(model.id, key.provider)) {
    return (!model.protocol || model.protocol === 'evolink') && modelModality(model, key) === 'image';
  }
  return EDIT_MODEL_PATTERN.test(model.id.toLowerCase().split('/').at(-1) ?? '')
    && ['openai', 'custom', 'seedream', 'tokendance', 'openrouter'].includes(key.provider)
    && (!model.protocol || (key.provider === 'openrouter' ? ['openai', 'openrouter'] : ['openai', 'ark']).includes(model.protocol))
    && modelModality(model, key) === 'image'
    && ['gpt-image', 'seedream', 'nano-banana'].includes(imageControlCaps(model.id, key.provider).family);
}

export function editSize(key: KeyView | undefined, model: string, width: number, height: number): { params: JobParams; error: string | null } {
  const fail = (error: string) => ({ params: {}, error });
  if (!key || !model) return fail('请选择编辑模型');
  if (width < 1 || height < 1 || Math.max(width, height) > 16384 || width * height > 16_777_216) return fail('画框不能超过 16384px 或 1600 万像素');
  // 原图与目标画框按实际像素提交，EvoLink 由 img_pos 定义位置，不使用生图尺寸参数。
  if (isEvolinkMidjourney(model, key.provider)) return { params: {}, error: null };
  const caps = imageControlCaps(model, key.provider, key.base_url);
  if (caps.sizeKind === 'ratio' || key.provider === 'openrouter') {
    const value = (ratio: string) => { const [a, b] = ratio.split(':').map(Number); return a / b; };
    const ratios = caps.ratios.filter(ratio => ratio !== 'auto');
    const ratio = [...ratios].sort((a, b) => Math.abs(value(a) / (width / height) - 1) - Math.abs(value(b) / (width / height) - 1))[0];
    if (!ratio || Math.abs(value(ratio) / (width / height) - 1) > .02) return fail('当前模型不支持这个画框比例');
    return { params: { size_mode: 'ratio', ratio, size: ratio }, error: null };
  }
  if (caps.family === 'gpt-image' && Math.max(width, height) / Math.min(width, height) > 3) return fail('GPT Image 的长短边比例不能超过 3:1');
  const size = normalizeImagePixelSize(`${width}x${height}`, model, key.base_url);
  const [a, b] = size.split('x').map(Number);
  if (!a || !b || Math.abs((a / b) / (width / height) - 1) > .02) return fail('当前模型无法匹配编辑画框比例');
  return { params: { size_mode: 'custom', size }, error: null };
}

export function drawEditStrokes(canvas: HTMLCanvasElement, strokes: EditStroke[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of strokes) {
    const first = stroke.points[0];
    const last = stroke.points.at(-1);
    if (!first || !last) continue;
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = ctx.strokeStyle = '#D4A574';
    if (stroke.tool === 'rectangle') {
      ctx.fillRect(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.abs(last.x - first.x), Math.abs(last.y - first.y));
    } else if (stroke.points.length === 1) {
      ctx.beginPath(); ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.lineWidth = stroke.size;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }
}

export async function editMaskBlob(width: number, height: number, strokes: EditStroke[]): Promise<Blob> {
  const selection = document.createElement('canvas');
  selection.width = width; selection.height = height;
  drawEditStrokes(selection, strokes);
  const ctx = selection.getContext('2d');
  if (!ctx || !ctx.getImageData(0, 0, width, height).data.some((v, i) => i % 4 === 3 && v > 0)) {
    throw new Error('请先选择需要修改的区域');
  }
  const mask = document.createElement('canvas');
  mask.width = width; mask.height = height;
  const out = mask.getContext('2d')!;
  out.fillStyle = 'white'; out.fillRect(0, 0, width, height);
  out.globalCompositeOperation = 'destination-out'; out.drawImage(selection, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => mask.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('无法读取选区，请重新打开编辑器');
  return blob;
}

export interface EditModelChoice { key: KeyView; model: string; name: string; mj: boolean }

/** 所有可用于图片编辑的「密钥 × 模型」，Midjourney 排在前面（扩图默认 MJ）。 */
export function editModelChoices(keys: readonly KeyView[]): EditModelChoice[] {
  const choices = keys.flatMap(key => key.models.filter(model => isEditModel(model, key)).map(model => ({
    key, model: model.id, name: model.name || model.id, mj: isEvolinkMidjourney(model.id, key.provider),
  })));
  return [...choices.filter(choice => choice.mj), ...choices.filter(choice => !choice.mj)];
}

export const EXPAND_RATIOS = ['original', '1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type ExpandRatio = typeof EXPAND_RATIOS[number];
export const EXPAND_SCALES = [1, 1.25, 1.5, 2, 2.5, 3] as const;
const MAX_FRAME_SIDE = 16000;
const MAX_FRAME_PIXELS = 16_777_216;

function ratioValue(ratio: ExpandRatio, width: number, height: number) {
  if (ratio === 'original') return width / height;
  const [a, b] = ratio.split(':').map(Number);
  return a / b;
}

/** 能完整装下原图的最小比例画框 × 倍数，原图居中；超过尺寸上限时整体缩回上限内。 */
export function presetFrame(width: number, height: number, ratio: ExpandRatio, scale: number): EditFrame {
  const value = ratioValue(ratio, width, height);
  let frameWidth = Math.max(width, height * value);
  let frameHeight = frameWidth / value;
  if (frameHeight < height) { frameHeight = height; frameWidth = height * value; }
  frameWidth *= scale; frameHeight *= scale;
  const limit = Math.min(1, MAX_FRAME_SIDE / Math.max(frameWidth, frameHeight), Math.sqrt(MAX_FRAME_PIXELS / (frameWidth * frameHeight)));
  const finalWidth = Math.max(width, Math.round(frameWidth * limit));
  const finalHeight = Math.max(height, Math.round(frameHeight * limit));
  return { width: finalWidth, height: finalHeight,
    x: Math.floor((finalWidth - width) / 2), y: Math.floor((finalHeight - height) / 2) };
}

/** 从已保存的画框反推最接近的倍数；比例不是预设时返回 null（自定义画框）。 */
export function presetScale(width: number, height: number, ratio: string, frame: EditFrame): number | null {
  if (!(EXPAND_RATIOS as readonly string[]).includes(ratio)) return null;
  const base = presetFrame(width, height, ratio as ExpandRatio, 1);
  const value = frame.width / base.width;
  return [...EXPAND_SCALES].sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0];
}
