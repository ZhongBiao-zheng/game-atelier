import {
  Crop,
  Download,
  Eye,
  Grid2X2,
  Scissors,
  Lock,
  Orbit,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react';

import type {
  CanvasImageQuickToolId,
  CanvasUiPreferences,
  CanvasUpscalePreferences,
  CanvasUpscaleTarget,
  CanvasUpscaleTierPreferences,
} from '@/schema/canvas';

export interface CanvasImageToolDefinition {
  id: CanvasImageQuickToolId;
  label: string;
  icon: LucideIcon;
  defaultVisible: boolean;
}

export const CANVAS_IMAGE_TOOLS: CanvasImageToolDefinition[] = [
  { id: 'info', label: '查看详情', icon: Eye, defaultVisible: true },
  { id: 'download', label: '下载图片', icon: Download, defaultVisible: true },
  { id: 'resize', label: '比例缩放', icon: Lock, defaultVisible: false },
  { id: 'crop', label: '裁剪', icon: Crop, defaultVisible: true },
  { id: 'split', label: '切分', icon: Grid2X2, defaultVisible: true },
  { id: 'removeBackground', label: '抠图', icon: Scissors, defaultVisible: true },
  { id: 'upscale', label: 'AI高清', icon: ZoomIn, defaultVisible: true },
  { id: 'angle', label: '多角度', icon: Orbit, defaultVisible: false },
];

/** AI高清档位：longEdge 是该档的目标长边，长边不超过原图的档位不展示；
 *  autoQuality 是未固定模型时自动选 Nano Banana 用的质量档，没有的档位（8K）必须手选模型。 */
export const CANVAS_UPSCALE_TARGETS: ReadonlyArray<{
  id: CanvasUpscaleTarget;
  longEdge: number;
  autoQuality: CanvasUpscaleTierPreferences['quality'];
}> = [
  { id: '2K', longEdge: 2048, autoQuality: 'medium' },
  { id: '4K', longEdge: 4096, autoQuality: 'high' },
  { id: '8K', longEdge: 8192, autoQuality: null },
];

// 提示词以服务端返回为准；这里只是加载前的占位，空串保存会被服务端填回内置提示词。
export function emptyCanvasUpscalePreferences(): CanvasUpscalePreferences {
  return {
    tiers: {
      '2K': { selection: null, quality: null, prompt: '' },
      '4K': { selection: null, quality: null, prompt: '' },
      '8K': { selection: null, quality: null, prompt: '' },
    },
  };
}

export const DEFAULT_CANVAS_IMAGE_TOOL_IDS = CANVAS_IMAGE_TOOLS
  .filter(tool => tool.defaultVisible)
  .map(tool => tool.id);

export const DEFAULT_CANVAS_UI_PREFERENCES: CanvasUiPreferences = {
  schema_version: 2,
  revision: 0,
  image_toolbar: {
    tool_ids: DEFAULT_CANVAS_IMAGE_TOOL_IDS,
  },
  generation_defaults: {
    text: { selection: null, params: {} },
    image: { selection: null, params: {} },
    video: { selection: null, params: {} },
    audio: { selection: null, params: {} },
  },
  upscale: emptyCanvasUpscalePreferences(),
  updated_at: null,
};

export function orderedCanvasImageTools(ids: CanvasImageQuickToolId[]) {
  const byId = new Map(CANVAS_IMAGE_TOOLS.map(tool => [tool.id, tool]));
  return ids.flatMap(id => {
    const tool = byId.get(id);
    return tool ? [tool] : [];
  });
}
