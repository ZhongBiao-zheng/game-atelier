import type { CreationAsset, CreationMediaAssetContent } from '@/schema/creationAssets';
import type { UseTeamMedia, UseTeamPrompt } from './teamAssetUse';
import type { CreationPromptSegment } from '@/schema/creationAssets';

/** 本机创作资产、团队库与项目参考库视图。 */
export type CreationAssetPanelMode = 'prompt' | 'media' | 'team' | 'reference';

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
  embedded?: boolean;
  refreshKey?: number;
  onAssetsChanged?: () => Promise<void>;
  className?: string;
  projectId?: string;
  canvasTargets?: { projectId: string; name: string }[];
  initialKind?: CreationAssetPanelMode;
  saveRequest?: CreationAssetSaveRequest | null;
  onSaveRequestHandled?: (requestId: string) => void;
  onClose: () => void;
  onUsePrompt: (
    asset: CreationAsset,
    renderedPrompt: string,
  ) => void;
  onUseMedia: (asset: CreationAsset, content: CreationMediaAssetContent) => void;
  onUseTeamMedia?: UseTeamMedia;
  onUseTeamPrompt?: UseTeamPrompt;
  /** 复刻生成资产（asset.kind 恒为 'generation'）；传了才显示「复刻」。 */
  onReproduce?: (asset: CreationAsset) => void;
  /** 透传给团队栏：有值时「相关配方」按参考 sha256 命中。 */
  teamRelatedSha256?: string | null;
  /** 团队栏初始选中的库；不在当前画布的挂载列表里就忽略。 */
  initialTeamLibraryId?: string | null;
  /** 没有 projectId（Studio）时团队栏初始落在哪个画布；不在 canvasTargets 里就退回第一个。 */
  initialTeamProjectId?: string | null;
}

export interface CreationAssetPanelHandle {
  requestClose: () => void;
  requestTransition: (action: () => void) => void;
}
