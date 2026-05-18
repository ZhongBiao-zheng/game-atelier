import { useEffect, useState } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { CharacterGallery } from './components/CharacterGallery';
import { SpecForm } from './components/SpecForm';

interface Config { image_storage_root: string }

export function App() {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig);
  }, []);

  if (config === null) return <div style={{ padding: 24 }}>加载中…</div>;
  if (!config.image_storage_root) {
    return <FirstRunConfigPlaceholder onSaved={setConfig} />;
  }
  return <ThreeColumnLayout />;
}

function FirstRunConfigPlaceholder({ onSaved }: { onSaved: (c: Config) => void }) {
  return (
    <div style={{ padding: 24 }}>
      <h1>首次配置（Task D8 替换）</h1>
      <button onClick={() => onSaved({ image_storage_root: '/tmp/images' })}>跳过</button>
    </div>
  );
}

function ThreeColumnLayout() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailJob, setDetailJob] = useState<{ path: string; jobId: string } | null>(null);
  const sseSignal = 0;  // Task D7 接 SSE 后改为 hook 返回值
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '20% 50% 30%', height: '100vh' }}>
      <LeftSidebar sseSignal={sseSignal} onSelect={setSelectedId} />
      <CharacterGallery
        characterId={selectedId}
        detailMode={detailJob !== null}
        onSelectImage={(path, jobId) => setDetailJob({ path, jobId })}
        sseSignal={sseSignal}
      />
      {detailJob === null
        ? <SpecForm characterId={selectedId} sseSignal={sseSignal} />
        : <ImageDetailPlaceholder onBack={() => setDetailJob(null)} />}
    </div>
  );
}

function ImageDetailPlaceholder({ onBack }: { onBack: () => void }) {
  return (
    <section style={{ borderLeft: '1px solid var(--color-border)', padding: 16 }}>
      <button onClick={onBack}>← 返回</button>
      <p>图片详情（Task D5）</p>
    </section>
  );
}
