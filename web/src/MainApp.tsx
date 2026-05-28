import { useEffect, useState } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { CharacterGallery } from './components/CharacterGallery';
import { ImageDetail } from './components/ImageDetail';
import { FirstRunConfig } from './components/FirstRunConfig';
import { useSSE } from './hooks/useSSE';
import { cn } from '@/lib/utils';

interface Config { image_storage_root: string }

interface MainAppProps {
  routedCharacterId?: string;
}

export function MainApp({ routedCharacterId }: MainAppProps = {}) {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig);
  }, []);

  if (config === null) {
    return (
      <div className="grid h-screen place-items-center bg-background text-muted-foreground">
        <span className="font-[var(--font-display)] italic text-2xl">读取设置…</span>
      </div>
    );
  }
  if (!config.image_storage_root) {
    return <FirstRunConfig onSaved={root => setConfig({ image_storage_root: root })} />;
  }
  return (
    <div className="h-screen">
      <ThreeColumnLayout routedCharacterId={routedCharacterId} />
    </div>
  );
}

function ThreeColumnLayout({ routedCharacterId }: { routedCharacterId?: string }) {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    routedCharacterId ? { id: routedCharacterId, name: '' } : null,
  );
  const [detailJob, setDetailJob] = useState<{ path: string; jobId: string } | null>(null);

  useEffect(() => {
    if (routedCharacterId && routedCharacterId !== selected?.id) {
      setSelected({ id: routedCharacterId, name: '' });
    }
  }, [routedCharacterId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sseSignal = useSSE();
  const detailMode = detailJob !== null;
  return (
    <div className={cn(
      'grid h-screen',
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
