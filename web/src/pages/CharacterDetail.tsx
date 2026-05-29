import { MainApp } from '@/MainApp';
import type { AssetSlot } from '@/schema/jobs';

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
  characterId,
  assetSlot,
  jobId,
  imagePath,
}: {
  characterId?: string;
  assetSlot?: string;
  jobId?: string;
  imagePath?: string;
} = {}) {
  return (
    <MainApp
      routedCharacterId={characterId}
      routedAssetSlot={isAssetSlot(assetSlot) ? assetSlot : undefined}
      routedImageDetail={jobId && imagePath ? { jobId, path: decodeRoutePath(imagePath) } : undefined}
    />
  );
}
