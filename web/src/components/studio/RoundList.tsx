import { type ButtonHTMLAttributes, useEffect, useState } from 'react';
import { AlertTriangle, Download, Trash2, X } from 'lucide-react';

import { WaitingCopy } from './WaitingCopy';

export interface RoundConfig {
  prompt: string;
  alias?: string | null;
  provider?: string | null;
  model: string;
  modelName?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  size?: string;
  n?: number;
  referenceImages: string[];
}

export type RoundState =
  | { kind: 'pending'; jobId?: string; startedAt: number; config: RoundConfig }
  | { kind: 'done'; jobId: string; submittedAt: string; imagePaths: string[]; config: RoundConfig }
  | { kind: 'failed'; jobId?: string; submittedAt: string; reason: string; config?: RoundConfig };

export function RoundList({
  rounds,
  onDeleteFailed,
  onReEdit,
  onRegenerate,
  onDeleteBatch,
}: {
  rounds: RoundState[];
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
}) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  if (rounds.length === 0) return null;
  return (
    <>
      <div data-testid="studio-round-list" className="max-w-[1024px] mx-auto mt-8 space-y-8">
        {rounds.map((r) => {
          const stableKey =
            r.kind === 'pending' && r.jobId ? `pending-${r.jobId}` :
            r.kind === 'pending' ? `pending-${r.startedAt}` :
            `${r.kind}-${r.submittedAt}`;
          return (
            <div key={stableKey}>
              {r.kind === 'pending' && (
                <div className="mb-3">
                  <WaitingCopy startedAt={r.startedAt} />
                </div>
              )}
              {r.kind === 'pending' && (
                <section className="space-y-3">
                  <div className="flex items-start gap-3 text-sm">
                    {r.config.referenceImages[0] && (
                      <img
                        src={imageSrc(r.config.referenceImages[0])}
                        alt="参考图"
                        className="h-14 w-14 rounded-md object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-base leading-7 text-foreground" title={r.config.prompt}>
                        {r.config.prompt}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Array.from({ length: Math.max(1, r.config.n ?? 1) }, (_, i) => (
                      <div
                        key={i}
                        data-testid={i === 0 && r.jobId ? `studio-pending-${r.jobId}` : undefined}
                        data-skeleton
                        aria-busy="true"
                        className="aspect-square w-[251.5px] bg-card/40 rounded-lg flex items-center justify-center"
                      >
                        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <ActionButton onClick={() => onReEdit?.(r.config)}>重新编辑</ActionButton>
                    <ActionButton onClick={() => { void onRegenerate?.(r.config); }}>再次生成</ActionButton>
                    {r.jobId && onDeleteFailed && (
                      <ActionButton compact aria-label="删除出图记录" title="删除出图记录" onClick={() => { void onDeleteFailed(r.jobId!); }}>
                        <Trash2 className="size-4" />
                      </ActionButton>
                    )}
                  </div>
                </section>
              )}
              {r.kind === 'done' && (
                <DoneBatch
                  round={r}
                  onReEdit={onReEdit}
                  onRegenerate={onRegenerate}
                  onDeleteBatch={onDeleteBatch}
                  onLightbox={setLightboxSrc}
                />
              )}
              {r.kind === 'failed' && (
                <FailedCard
                  round={r}
                  onDeleteFailed={onDeleteFailed}
                  onReEdit={onReEdit}
                  onRegenerate={onRegenerate}
                />
              )}
            </div>
          );
        })}
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

function imageSrc(path: string) {
  return `/api/gallery/image?path=${encodeURIComponent(path)}`;
}

function DoneBatch({
  round,
  onReEdit,
  onRegenerate,
  onDeleteBatch,
  onLightbox,
}: {
  round: Extract<RoundState, { kind: 'done' }>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
  onLightbox?: (src: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = [
    round.config.modelName ?? round.config.model,
    round.config.size,
    round.config.ratio,
    round.config.resolution,
    round.config.n && round.config.n > 1 ? `${round.config.n} 张` : undefined,
  ].filter(Boolean);

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3 text-sm">
        {round.config.referenceImages[0] && (
          <img
            src={imageSrc(round.config.referenceImages[0])}
            alt="参考图"
            className="h-14 w-14 rounded-md object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-base leading-7 text-foreground" title={round.config.prompt}>
            {round.config.prompt}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{meta.join(' | ')}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {round.imagePaths.map((path, index) => (
          <figure
            key={path}
            data-testid={`studio-result-thumb-${index + 1}`}
            className="group relative w-[251.5px] overflow-hidden rounded-md bg-card cursor-pointer"
            onClick={() => onLightbox?.(imageSrc(path))}
          >
            <img
              src={imageSrc(path)}
              alt={`生成结果 ${index + 1}`}
              className="h-full w-full object-contain"
            />
            <a
              href={imageSrc(path)}
              download={path.split('/').pop() || `${round.jobId}-${index + 1}.png`}
              aria-label={`下载生成结果 ${index + 1}`}
              title="下载图片"
              className="absolute right-2 top-2 grid size-8 place-items-center rounded-full border border-white/20 bg-black/70 text-white opacity-0 shadow-lg backdrop-blur-sm transition-opacity hover:bg-black/85 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Download className="size-4" aria-hidden />
            </a>
          </figure>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <ActionButton onClick={() => onReEdit?.(round.config)}>重新编辑</ActionButton>
        <ActionButton onClick={() => { void onRegenerate?.(round.config); }}>再次生成</ActionButton>
        <div className="relative">
          <ActionButton compact aria-label="更多操作" onClick={() => setMenuOpen((value) => !value)}>...</ActionButton>
          {menuOpen && (
            <div data-testid="studio-more-menu" className="absolute left-full top-0 z-10 ml-2 h-11 w-[195px] rounded-xl bg-secondary p-0 shadow-xl">
              <button
                type="button"
                aria-label="删除该批次结果"
                className="flex h-11 w-full items-center gap-2 rounded-xl px-3 py-[9px] text-left text-[13px] font-medium text-foreground hover:bg-secondary/80"
                onClick={() => {
                  setMenuOpen(false);
                  void onDeleteBatch?.(round.jobId, round.imagePaths);
                }}
              >
                <Trash2 className="size-4 shrink-0" aria-hidden />
                删除该批次结果
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ActionButton({
  compact = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { compact?: boolean }) {
  return (
    <button
      type="button"
      className={`${compact ? 'h-9 w-9 px-0' : 'h-9 w-[94px] px-3'} rounded-xl bg-secondary text-sm font-medium text-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
      {...props}
    />
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <img
        src={src}
        alt="大图"
        className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl object-contain"
        onClick={e => e.stopPropagation()}
      />
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute right-6 top-6 size-10 rounded-full bg-black/60 text-white grid place-items-center hover:bg-black/80 backdrop-blur-sm border-0"
      >
        <X className="size-5" />
      </button>
    </div>
  );
}

function FailedCard({
  round,
  onDeleteFailed,
  onReEdit,
  onRegenerate,
}: {
  round: Extract<RoundState, { kind: 'failed' }>;
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
}) {
  const { config } = round;
  const meta = config
    ? [
        config.modelName ?? config.model,
        config.size,
        config.ratio,
        config.resolution,
        config.n && config.n > 1 ? `${config.n} 张` : undefined,
      ].filter(Boolean)
    : [];

  return (
    <section className="space-y-3">
      {config && (
        <div className="flex items-start gap-3 text-sm">
          {config.referenceImages[0] && (
            <img
              src={imageSrc(config.referenceImages[0])}
              alt="参考图"
              className="h-14 w-14 rounded-md object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-base leading-7 text-foreground" title={config.prompt}>
              {config.prompt}
            </p>
            {meta.length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">{meta.join(' | ')}</p>
            )}
          </div>
        </div>
      )}
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive/70" aria-hidden />
        <p className="flex-1 text-muted-foreground">{round.reason}</p>
        {round.jobId && onDeleteFailed && (
          <button
            type="button"
            aria-label="删除失败记录"
            title="删除失败记录"
            onClick={() => { void onDeleteFailed(round.jobId!); }}
            className="rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            删除
          </button>
        )}
      </div>
      {config && (
        <div className="flex items-center gap-2">
          <ActionButton onClick={() => onReEdit?.(config)}>重新编辑</ActionButton>
          <ActionButton onClick={() => { void onRegenerate?.(config); }}>再次生成</ActionButton>
        </div>
      )}
    </section>
  );
}
