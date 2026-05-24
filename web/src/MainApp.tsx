import { useEffect, useState } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { CharacterGallery } from './components/CharacterGallery';
import { SpecForm } from './components/SpecForm';
import { ImageDetail } from './components/ImageDetail';
import { FirstRunConfig } from './components/FirstRunConfig';
import { useSSE } from './hooks/useSSE';
import { cn } from '@/lib/utils';

interface Config { image_storage_root: string }

export function MainApp() {
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
  return <ThreeColumnLayout />;
}

function ThreeColumnLayout() {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [detailJob, setDetailJob] = useState<{ path: string; jobId: string } | null>(null);
  const sseSignal = useSSE();
  const detailMode = detailJob !== null;
  return (
    <div className={cn(
      'grid h-screen',
      detailMode
        ? 'grid-cols-[280px_360px_1fr]'
        : 'grid-cols-[280px_1fr_380px]',
    )}>
      <LeftSidebar
        sseSignal={sseSignal}
        selectedId={selected?.id}
        onSelect={(id, name) => setSelected({ id, name })}
      />
      <CharacterGallery
        characterId={selected?.id ?? null}
        characterName={selected?.name ?? null}
        detailMode={detailMode}
        onSelectImage={(path, jobId) => setDetailJob({ path, jobId })}
        sseSignal={sseSignal}
      />
      {detailJob === null
        ? <SpecForm
            characterId={selected?.id ?? null}
            characterName={selected?.name ?? null}
            sseSignal={sseSignal}
          />
        : <ImageDetail
            jobId={detailJob.jobId}
            path={detailJob.path}
            onBack={() => setDetailJob(null)}
          />}
    </div>
  );
}
