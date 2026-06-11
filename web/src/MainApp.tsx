import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
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
        <span className="font-display text-display italic">读取设置…</span>
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

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-glass"
      onClick={onClose}
    >
      <img
        src={src}
        alt="大图"
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={e => e.stopPropagation()}
      />
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute right-6 top-6 size-10 rounded-full bg-scrim text-white grid place-items-center hover:bg-background/90 backdrop-blur-glass border-0"
      >
        <X className="size-5" />
      </button>
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

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const detailMode = detailJob !== null;
  return (
    <>
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
              onLightbox={setLightboxSrc}
            />}
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
