import type { HistoryReference } from '@/api/history';
import type { CreationPromptSegment } from '@/schema/creationAssets';

/** 生成结果的来源：有它时保存为带配方的生成资产，而不是普通媒体。 */
export type CreationGenerationSource =
  | { kind: 'job_output'; job_id: string; output_index: number }
  | { kind: 'canvas_result'; canvas_project_id: string; node_id: string; version_id: string };

/** 待保存媒体的类型：预览 URL 不一定带后缀，由调用方说明；缺省按 sourcePath 后缀判断。 */
export type CreationMediaKind = 'image' | 'video';

export type CreationAssetSaveRequest =
  | {
    requestId: string;
    kind: 'prompt';
    title?: string;
    segments: CreationPromptSegment[];
    projectId?: string;
  }
  | {
    requestId: string;
    kind: 'media';
    title?: string;
    file?: File;
    sourcePath?: string;
    previewUrl?: string;
    mediaKind?: CreationMediaKind;
    projectId?: string;
    source?: CreationGenerationSource;
  };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CreationAssetPanelProps {
  className?: string;
  projectId?: string;
  openLibrary?: boolean;
  saveRequest?: CreationAssetSaveRequest | null;
  onSaveRequestHandled?: (requestId: string) => void;
  onClose: () => void;
  onHistoryReference: (items: HistoryReference[], placeOnCanvas?: boolean) => Promise<void>;
  onSubject?: (token: string) => void;
}
