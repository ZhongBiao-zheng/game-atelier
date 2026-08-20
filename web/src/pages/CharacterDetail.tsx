import { MainApp } from '@/MainApp';
import type { AssetSlot } from '@/schema/jobs';
import type { WorkshopWorkspace } from '@/pages/ProjectPage';
import type { ProjectFolderView } from '@/pages/ProjectFolderPage';

function isAssetSlot(value?: string): value is AssetSlot {
  return value === 'portrait' || value === 'promo' || value === 'turnaround';
}

function decodeRoutePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function CharacterDetail({
  projectId,
  workspace,
  uiSchemeId,
  screenId,
  productionId,
  shotId,
  characterId,
  assetSlot,
  jobId,
  imagePath,
  folderId,
  folderView,
}: {
  projectId?: string;
  workspace?: WorkshopWorkspace;
  uiSchemeId?: string;
  screenId?: string;
  productionId?: string;
  shotId?: string;
  characterId?: string;
  assetSlot?: string;
  jobId?: string;
  imagePath?: string;
  folderId?: string;
  folderView?: ProjectFolderView;
} = {}) {
  return (
    <MainApp
      routedProjectId={projectId}
      routedWorkspace={workspace}
      routedUiSchemeId={uiSchemeId}
      routedScreenId={screenId}
      routedProductionId={productionId}
      routedShotId={shotId}
      routedCharacterId={characterId}
      routedAssetSlot={isAssetSlot(assetSlot) ? assetSlot : undefined}
      routedImageDetail={jobId && imagePath ? { jobId, path: decodeRoutePath(imagePath) } : undefined}
      routedFolderId={folderId}
      routedFolderView={folderView}
    />
  );
}
