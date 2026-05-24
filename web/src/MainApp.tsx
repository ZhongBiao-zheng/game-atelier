import { useEffect, useState } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { CharacterGallery } from './components/CharacterGallery';
import { SpecForm } from './components/SpecForm';
import { ImageDetail } from './components/ImageDetail';
import { FirstRunConfig } from './components/FirstRunConfig';
import { KeysPage } from './pages/settings/Keys';
import { useSSE } from './hooks/useSSE';
import { cn } from '@/lib/utils';

interface Config { image_storage_root: string }

export function MainApp() {
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<'main' | 'keys'>('main');

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
    <div className="relative h-screen">
      <button
        type="button"
        onClick={() => setView(view === 'keys' ? 'main' : 'keys')}
        className="absolute right-4 top-3 z-50 rounded border border-stone-700/60 bg-stone-900/80 px-3 py-1 text-sm text-stone-100 backdrop-blur hover:bg-stone-800"
      >
        {view === 'keys' ? '返回' : 'API Keys'}
      </button>
      {view === 'keys' ? <KeysPage /> : <ThreeColumnLayout />}
    </div>
  );
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
