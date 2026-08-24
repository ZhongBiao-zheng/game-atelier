import {
  ClipboardCopy,
  Crop,
  Download,
  Eye,
  FileUp,
  Grid2X2,
  Library,
  Lock,
  Orbit,
  Paintbrush,
  ScanText,
  Trash2,
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
  { id: 'delete', label: '删除节点', icon: Trash2, defaultVisible: true },
  { id: 'saveAsset', label: '存入资产库', icon: Library, defaultVisible: true },
  { id: 'download', label: '下载图片', icon: Download, defaultVisible: true },
  { id: 'copyPrompt', label: '复制提示词', icon: ClipboardCopy, defaultVisible: true },
  { id: 'reversePrompt', label: '反推提示词', icon: ScanText, defaultVisible: true },
  { id: 'replace', label: '替换图片', icon: FileUp, defaultVisible: true },
  { id: 'resize', label: '比例缩放', icon: Lock, defaultVisible: false },
  { id: 'maskEdit', label: '局部编辑', icon: Paintbrush, defaultVisible: true },
  { id: 'crop', label: '裁剪', icon: Crop, defaultVisible: true },
  { id: 'split', label: '切分', icon: Grid2X2, defaultVisible: true },
  { id: 'upscale', label: '本地放大', icon: ZoomIn, defaultVisible: true },
  { id: 'angle', label: '多角度', icon: Orbit, defaultVisible: false },
];

export const DEFAULT_CANVAS_IMAGE_TOOL_IDS = CANVAS_IMAGE_TOOLS
  .filter(tool => tool.defaultVisible)
  .map(tool => tool.id);

export const DEFAULT_CANVAS_UI_PREFERENCES: CanvasUiPreferences = {
  schema_version: 1,
  revision: 0,
  image_toolbar: {
    tool_ids: DEFAULT_CANVAS_IMAGE_TOOL_IDS,
    show_labels: false,
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
