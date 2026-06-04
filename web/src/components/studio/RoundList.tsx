import { type ButtonHTMLAttributes, useEffect, useRef, useState } from 'react';
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
  quality?: 'low' | 'medium' | 'high' | 'auto';
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
  onReuseReferences,
}: {
  rounds: RoundState[];
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
  onReuseReferences?: (paths: string[]) => void | Promise<void>;
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
                    <ReferenceStack refs={r.config.referenceImages} onReuse={onReuseReferences} />
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
                  onReuseReferences={onReuseReferences}
                />
              )}
              {r.kind === 'failed' && (
                <FailedCard
                  round={r}
                  onDeleteFailed={onDeleteFailed}
                  onReEdit={onReEdit}
                  onRegenerate={onRegenerate}
                  onReuseReferences={onReuseReferences}
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

// 参考图来自 .runtime/uploads/（走 /api/raw），也可能是 http(s) CDN 直链。
function refImageSrc(path: string) {
  return path.startsWith('http') ? path : `/api/raw?path=${encodeURIComponent(path)}`;
}

const REF_CARD_W = 46;
const REF_CARD_H = 58;
const REF_ROTATIONS = [-6, 5, -4, 7, -5, 4, -3, 6];
const REF_OVERLAP_REST = 30;
const REF_OVERLAP_HOVER = 8;

// 出图历史里提示词左侧的参考图堆叠：未 hover 重叠旋转成一叠；hover 时整组散开、每张以中心为轴放大；点击整组复用。
function ReferenceStack({
  refs,
  onReuse,
}: {
  refs: string[];
  onReuse?: (paths: string[]) => void | Promise<void>;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  if (refs.length === 0) return null;
  return (
    <button
      type="button"
      data-testid="reference-stack"
      title="点击复用这组参考图"
      aria-label="复用这组参考图"
      onClick={() => { void onReuse?.(refs); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(null); }}
      className="group relative z-20 flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0"
    >
      {refs.map((src, i) => {
        const angle = REF_ROTATIONS[i % REF_ROTATIONS.length];
        const isActive = active === i;
        const scale = isActive ? 1.18 : hover ? 1.1 : 1;
        return (
          <span
            key={i}
            onMouseEnter={() => setActive(i)}
            style={{
              width: REF_CARD_W,
              height: REF_CARD_H,
              marginLeft: i === 0 ? 0 : -(hover ? REF_OVERLAP_HOVER : REF_OVERLAP_REST),
              zIndex: isActive ? 30 : i,
              transform: `rotate(${angle}deg) scale(${scale})`,
              transformOrigin: 'center',
              transition: 'transform 250ms ease, margin-left 250ms ease',
            }}
            className="relative block overflow-hidden rounded-lg border-[1.5px] border-white bg-card shadow-md"
          >
            <img src={refImageSrc(src)} alt="参考图" className="h-full w-full object-cover" draggable={false} />
          </span>
        );
      })}
    </button>
  );
}

function DoneBatch({
  round,
  onReEdit,
  onRegenerate,
  onDeleteBatch,
  onLightbox,
  onReuseReferences,
}: {
  round: Extract<RoundState, { kind: 'done' }>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
  onLightbox?: (src: string) => void;
  onReuseReferences?: (paths: string[]) => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);
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
        <ReferenceStack refs={round.config.referenceImages} onReuse={onReuseReferences} />
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
        <div className="relative" ref={menuWrapRef}>
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
      className={`inline-flex items-center justify-center ${compact ? 'h-9 w-9 px-0' : 'h-9 w-[94px] px-3'} rounded-xl bg-secondary text-sm font-medium text-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
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
  onReuseReferences,
}: {
  round: Extract<RoundState, { kind: 'failed' }>;
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onReuseReferences?: (paths: string[]) => void | Promise<void>;
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
          <ReferenceStack refs={config.referenceImages} onReuse={onReuseReferences} />
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
