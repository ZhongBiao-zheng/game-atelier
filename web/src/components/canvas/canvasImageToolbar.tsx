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
  { id: 'upscale', label: '本地放大', icon: ZoomIn, defaultVisible: true },
  { id: 'angle', label: '多角度', icon: Orbit, defaultVisible: false },
];

export const DEFAULT_CANVAS_IMAGE_TOOL_IDS = CANVAS_IMAGE_TOOLS
  .filter(tool => tool.defaultVisible)
  .map(tool => tool.id);

export const DEFAULT_CANVAS_UI_PREFERENCES: CanvasUiPreferences = {
  schema_version: 2,
  revision: 0,
  image_toolbar: {
    tool_ids: DEFAULT_CANVAS_IMAGE_TOOL_IDS,
    show_labels: false,
  },
  generation_defaults: {
    text: { selection: null, params: {} },
    image: { selection: null, params: {} },
    video: { selection: null, params: {} },
    audio: { selection: null, params: {} },
  },
  updated_at: null,
};

export function orderedCanvasImageTools(ids: CanvasImageQuickToolId[]) {
  const byId = new Map(CANVAS_IMAGE_TOOLS.map(tool => [tool.id, tool]));
  return ids.flatMap(id => {
    const tool = byId.get(id);
    return tool ? [tool] : [];
  });
}
