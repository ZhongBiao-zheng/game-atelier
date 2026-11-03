import { useState } from 'react';
import { teamPromptPreviewUrl } from '@/api/teamLibraries';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TeamLibraryIndexEntry } from '@/schema/teamLibrary';

export function TeamPromptPreviewGallery({ libraryId, entry }: { libraryId: string; entry: TeamLibraryIndexEntry }) {
  const previews = entry.preview_images ?? [];
  const [selectedFile, setSelectedFile] = useState<string>();
  const selected = previews.find(p => p.file === selectedFile) ?? previews[0];
  if (!selected) return null;
  return <div className="space-y-2">
    <img src={teamPromptPreviewUrl(libraryId, entry.id, selected.file, 512)} alt={`${entry.title}效果图`}
      className="max-h-120 w-full rounded-lg object-contain" />
    {previews.length > 1 && <div className="grid grid-cols-4 gap-2">
      {previews.map((preview, index) => <Button key={preview.file} variant="ghost" aria-label={`查看团队效果图 ${index + 1}`}
        aria-pressed={preview.file === selected.file} onClick={() => setSelectedFile(preview.file)}
        className={cn('aspect-square h-auto overflow-hidden rounded-md p-0', preview.file === selected.file && 'ring-2 ring-primary')}>
        <img src={teamPromptPreviewUrl(libraryId, entry.id, preview.file, 128)} alt="" className="h-full w-full object-cover" />
      </Button>)}
    </div>}
  </div>;
}
