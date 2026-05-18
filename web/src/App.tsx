import { useEffect, useState } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { CharacterGallery } from './components/CharacterGallery';
import { SpecForm } from './components/SpecForm';
import { ImageDetail } from './components/ImageDetail';
import { FirstRunConfig } from './components/FirstRunConfig';
import { useSSE } from './hooks/useSSE';

interface Config { image_storage_root: string }

export function App() {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig);
  }, []);

  if (config === null) return <div style={{ padding: 24 }}>加载中…</div>;
  if (!config.image_storage_root) {
    return <FirstRunConfig onSaved={root => setConfig({ image_storage_root: root })} />;
  }
  return <ThreeColumnLayout />;
}

function ThreeColumnLayout() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailJob, setDetailJob] = useState<{ path: string; jobId: string } | null>(null);
  const sseSignal = useSSE();
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: detailJob === null ? '20% 50% 30%' : '20% 30% 50%',
      height: '100vh',
    }}>
      <LeftSidebar sseSignal={sseSignal} onSelect={setSelectedId} />
      <CharacterGallery
        characterId={selectedId}
        detailMode={detailJob !== null}
        onSelectImage={(path, jobId) => setDetailJob({ path, jobId })}
        sseSignal={sseSignal}
      />
      {detailJob === null
        ? <SpecForm characterId={selectedId} sseSignal={sseSignal} />
        : <ImageDetail jobId={detailJob.jobId} path={detailJob.path} onBack={() => setDetailJob(null)} />}
    </div>
  );
}
