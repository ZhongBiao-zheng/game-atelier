import { useEffect, useState } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { CharacterGallery } from './components/CharacterGallery';
import { ImageDetail } from './components/ImageDetail';
import { FirstRunConfig } from './components/FirstRunConfig';
import { useSSE } from './hooks/useSSE';
import { useActiveCharacter } from './hooks/useActiveCharacter';
import { cn } from '@/lib/utils';
import type { AssetSlot, CharacterEntry } from './schema/jobs';

interface Config { image_storage_root: string }

interface MainAppProps {
  routedCharacterId?: string;
  routedAssetSlot?: AssetSlot;
  routedImageDetail?: { path: string; jobId: string };
}

export function MainApp({ routedCharacterId, routedAssetSlot, routedImageDetail }: MainAppProps = {}) {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig);
  }, []);

  if (config === null) {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground">
        <span className="font-[var(--font-display)] italic text-2xl">读取设置…</span>
      </div>
    );
  }
  if (!config.image_storage_root) {
    return <FirstRunConfig onSaved={root => setConfig({ image_storage_root: root })} />;
  }
  return (
    <div className="h-full">
      <ThreeColumnLayout
        routedCharacterId={routedCharacterId}
        routedAssetSlot={routedAssetSlot}
        routedImageDetail={routedImageDetail}
      />
    </div>
  );
}

function ThreeColumnLayout({
  routedCharacterId,
  routedAssetSlot,
  routedImageDetail,
}: {
  routedCharacterId?: string;
  routedAssetSlot?: AssetSlot;
  routedImageDetail?: { path: string; jobId: string };
}) {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    routedCharacterId ? { id: routedCharacterId, name: '' } : null,
  );
  const [detailJob, setDetailJob] = useState<{ path: string; jobId: string } | null>(
    routedImageDetail ?? null,
  );
  const sseSignal = useSSE();
  const activeId = useActiveCharacter(sseSignal);

  useEffect(() => {
    if (routedCharacterId && routedCharacterId !== selected?.id) {
      setSelected({ id: routedCharacterId, name: '' });
    }
  }, [routedCharacterId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!routedCharacterId && !selected && activeId) {
      setSelected({ id: activeId, name: '' });
    }
  }, [activeId, routedCharacterId, selected]);

  useEffect(() => {
    setDetailJob(routedImageDetail ?? null);
  }, [routedImageDetail?.jobId, routedImageDetail?.path]);

  useEffect(() => {
    if (!selected || selected.name) return;
    let cancelled = false;
    fetch('/api/characters')
      .then(r => r.json() as Promise<CharacterEntry[]>)
      .then(chars => {
        if (cancelled) return;
        const match = chars.find(c => c.id === selected.id);
        if (match) setSelected({ id: match.id, name: match.name });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selected]);

  const detailMode = detailJob !== null;
  return (
    <div className={cn(
      'grid h-full',
      detailMode
        ? 'grid-cols-[280px_360px_1fr]'
        : 'grid-cols-[280px_1fr]',
    )}>
      <LeftSidebar
        sseSignal={sseSignal}
        selectedId={selected?.id}
        onSelect={(id, name) => setSelected({ id, name })}
        onDelete={(id) => {
          if (selected?.id === id) setSelected(null);
        }}
      />
      <CharacterGallery
        characterId={selected?.id ?? null}
        characterName={selected?.name ?? null}
        initialTab={routedAssetSlot}
        detailMode={detailMode}
        onSelectImage={(path, jobId) => setDetailJob({ path, jobId })}
        sseSignal={sseSignal}
      />
      {detailJob === null
        ? null
        : <ImageDetail
            jobId={detailJob.jobId}
            path={detailJob.path}
            onBack={() => setDetailJob(null)}
          />}
    </div>
  );
}
