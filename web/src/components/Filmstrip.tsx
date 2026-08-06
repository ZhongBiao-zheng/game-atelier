import { useEffect, useState } from 'react';
import type { AssetSlot, Job } from '../schema/jobs';
import { cn } from '@/lib/utils';

const SLOT_LABEL: Record<AssetSlot, string> = {
  portrait: '立绘',
  promo: '美宣',
  turnaround: '三视图',
};

interface Props {
  characterId: string;
  assetSlot: AssetSlot;
  currentPath: string;
  onSelect: (path: string, jobId: string) => void;
  sseSignal: number;
}

/** 详情态左侧胶片带：当前 slot 的图纵排，当前张铜环全亮，其余半透明，点击切图。 */
export function Filmstrip({ characterId, assetSlot, currentPath, onSelect, sseSignal }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/jobs')
      .then(r => r.json() as Promise<Job[]>)
      .then(all => {
        if (cancelled || !Array.isArray(all)) return;
        setJobs(all.filter(j => j.character_id === characterId));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [characterId, sseSignal]);

  const slotOf = (j: Job): AssetSlot => j.asset_slot ?? 'portrait';
  const images = jobs
    .filter(j => slotOf(j) === assetSlot)
    .flatMap(j => j.output_paths.map(p => ({ path: p, jobId: j.job_id })));
  const others = (Object.keys(SLOT_LABEL) as AssetSlot[])
    .filter(s => s !== assetSlot)
    .map(s => {
      const n = jobs.filter(j => slotOf(j) === s).reduce((sum, j) => sum + j.output_paths.length, 0);
      return `${SLOT_LABEL[s]} ${n}`;
    })
    .join(' · ');

  return (
    <aside className="col-start-1 flex h-full min-w-0 flex-col gap-2.5 overflow-y-auto stable-scroll border-r border-border px-3 py-4">
      <div className="whitespace-nowrap text-center text-xs uppercase tracking-label text-muted-foreground/70">
        {SLOT_LABEL[assetSlot]} · {images.length}
      </div>
      {images.map(img => {
        const current = img.path === currentPath;
        return (
          <button
            key={`${img.jobId}-${img.path}`}
            onClick={() => onSelect(img.path, img.jobId)}
            aria-label={current ? '当前图片' : '切换到这张图'}
            aria-current={current || undefined}
            className={cn(
              'block w-full shrink-0 cursor-pointer overflow-hidden rounded-md border bg-card p-0 transition-opacity',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              current ? 'border-primary/70' : 'border-border opacity-55 hover:opacity-100',
            )}
          >
            <img
              src={`/api/raw?path=${encodeURIComponent(img.path)}&job_id=${encodeURIComponent(img.jobId)}`}
              alt=""
              className="block aspect-[3/2] w-full object-cover"
            />
          </button>
        );
      })}
      {others && (
        <div className="mt-auto pt-2 text-center font-mono text-xs tabular-nums leading-relaxed text-muted-foreground/50">
          {others}
        </div>
      )}
    </aside>
  );
}
