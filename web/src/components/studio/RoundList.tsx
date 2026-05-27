import { type ButtonHTMLAttributes, useState } from 'react';
import { Download } from 'lucide-react';

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
  referenceImages: string[];
}

export type RoundState =
  | { kind: 'pending'; jobId?: string; startedAt: number; config: RoundConfig }
  | { kind: 'done'; jobId: string; submittedAt: string; imagePaths: string[]; config: RoundConfig }
  | { kind: 'failed'; jobId?: string; submittedAt: string; reason: string };

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
  if (rounds.length === 0) return null;
  return (
    <div className="max-w-3xl mx-auto mt-8 space-y-8">
      {rounds.map((r) => {
        const stableKey =
          r.kind === 'pending' ? `pending-${r.startedAt}` : `${r.kind}-${r.submittedAt}`;
        return (
          <div key={stableKey}>
            <div className="border-t border-border/40 pt-3 mb-3 flex items-baseline gap-3">
              <span className="text-xs text-muted-foreground font-mono">
                {r.kind === 'pending'
                  ? new Date(r.startedAt).toLocaleTimeString()
                  : new Date(r.submittedAt).toLocaleTimeString()}
              </span>
              {r.kind === 'pending' && <WaitingCopy startedAt={r.startedAt} />}
            </div>
            {r.kind === 'pending' && (
              <div
                data-skeleton
                aria-busy="true"
                className="aspect-square w-64 bg-card/40 rounded-lg flex items-center justify-center"
              >
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {r.kind === 'done' && (
              <DoneBatch
                round={r}
                onReEdit={onReEdit}
                onRegenerate={onRegenerate}
                onDeleteBatch={onDeleteBatch}
              />
            )}
            {r.kind === 'failed' && (
              <div className="relative border border-destructive/40 rounded-lg p-4 max-w-sm text-sm">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-foreground">生成失败</p>
                  {r.jobId && onDeleteFailed && (
                    <button
                      type="button"
                      aria-label="删除失败记录"
                      title="删除失败记录"
                      onClick={() => { void onDeleteFailed(r.jobId!); }}
                      className="rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      删除
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{r.reason}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
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
}: {
  round: Extract<RoundState, { kind: 'done' }>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = [
    round.config.modelName ?? round.config.model,
    round.config.size,
    round.config.ratio,
    round.config.resolution,
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
            className="group relative w-[251.5px] overflow-hidden rounded-md bg-card"
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
            <div data-testid="studio-more-menu" className="absolute left-full top-0 z-10 ml-2 w-44 rounded-xl border border-border bg-popover p-1 shadow-xl">
              <button
                type="button"
                className="h-10 w-full rounded-lg px-3 text-left text-sm text-destructive hover:bg-destructive/10"
                onClick={() => {
                  setMenuOpen(false);
                  void onDeleteBatch?.(round.jobId, round.imagePaths);
                }}
              >
                删除当前批次的结果
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
