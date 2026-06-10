import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Loader2, Upload, X } from 'lucide-react';
import type { AssetSlot, Job } from '../schema/jobs';
import { fetchGalleryHidden, isGalleryHidden, setGalleryHidden } from '@/api/gallery';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  characterId: string | null;
  characterName: string | null;
  initialTab?: TabKind;
  detailMode: boolean;
  onSelectImage: (path: string, jobId: string) => void;
  sseSignal: number;
}

type TabKind = 'portrait' | 'promo' | 'turnaround';

// pending 超过 1 小时仍未翻面 → 出图进程（Skill）大概率已中断（与后端 STALE_PENDING_MINUTES 一致）。
const STALE_PENDING_MS = 60 * 60 * 1000;

function isStalePending(j: Job): boolean {
  if (j.status !== 'pending') return false;
  const t = Date.parse(j.submitted_at);
  // 解析不了（脏数据）也视同超时，给作废出口。
  return !Number.isFinite(t) || Date.now() - t > STALE_PENDING_MS;
}

const TAB_META: Record<TabKind, { label: string; emptyTitle: string; emptyHint: string }> = {
  portrait: {
    label: '立绘',
    emptyTitle: '等待第一张作品',
    emptyHint: '保存档案后将触发首轮出图',
  },
  promo: {
    label: '美宣',
    emptyTitle: '等待第一张美宣',
    emptyHint: '上传源图后在 CC 触发 /game-atelier:promo',
  },
  turnaround: {
    label: '三视图',
    emptyTitle: '等待第一张三视图',
    emptyHint: '上传源图后在 CC 触发 /game-atelier:turnaround',
  },
};

export function CharacterGallery({
  characterId,
  characterName,
  initialTab,
  detailMode,
  onSelectImage,
  sseSignal,
}: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<TabKind>(initialTab ?? 'portrait');
  const [uploadSignal, setUploadSignal] = useState(0);
  const [colCount, setColCount] = useState(detailMode ? 2 : 3);
  // 首页作品展示的隐藏清单（工坊内不受影响，仅作状态标识 + 切换入口）。
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    fetchGalleryHidden().then(setHiddenPaths).catch(() => {});
  }, []);

  useEffect(() => {
    if (!characterId) return;
    setLoading(true);
    fetch(`/api/jobs`)
      .then(r => r.json() as Promise<Job[]>)
      .then(all => setJobs(all.filter(j => j.character_id === characterId)))
      .finally(() => setLoading(false));
  }, [characterId, sseSignal, uploadSignal]);

  if (!characterId) return <EmptyShell title="请在左栏选择角色" subtitle="Atelier · 角色资产工坊" />;

  // 旧 job 无 kind 字段时按 PORTRAIT 处理（后端 Pydantic 默认值，前端二次兜底防漂移）
  const jobKind = (j: Job): AssetSlot => j.asset_slot ?? 'portrait';
  const tabJobs = jobs.filter(j => jobKind(j) === tab);
  const tabCounts: Record<TabKind, number> = {
    portrait: jobs.filter(j => jobKind(j) === 'portrait').reduce((s, j) => s + j.output_paths.length, 0),
    promo: jobs.filter(j => jobKind(j) === 'promo').reduce((s, j) => s + j.output_paths.length, 0),
    turnaround: jobs.filter(j => jobKind(j) === 'turnaround').reduce((s, j) => s + j.output_paths.length, 0),
  };

  if (loading && jobs.length === 0) {
    return (
      <GalleryShell name={characterName} count={0} rounds={0} compact={detailMode}
        tab={tab} setTab={setTab} tabCounts={tabCounts}
        colCount={colCount} onColCountChange={setColCount}>
        <Skeleton cols={colCount} />
      </GalleryShell>
    );
  }

  const allImages: { path: string; jobId: string; status: Job['status'] }[] = [];
  tabJobs.forEach(j => j.output_paths.forEach(p => allImages.push({ path: p, jobId: j.job_id, status: j.status })));
  const failedJobs = tabJobs.filter(j => j.status === 'failed');
  const isRunning = tabJobs.some(j => j.status === 'pending');

  async function deleteImage(jobId: string, path: string) {
    if (!window.confirm(`删除这张图？\n${path}\n（磁盘文件也会删，不可恢复）`)) return;
    const r = await fetch(`/api/jobs/${jobId}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!r.ok) { alert(`删除失败：HTTP ${r.status}`); return; }
    setJobs(js => js.map(j => j.job_id === jobId
      ? { ...j, output_paths: j.output_paths.filter(p => p !== path) }
        : j));
  }

  async function deleteFailedJob(jobId: string) {
    if (!window.confirm(`删除这个失败记录？\n${jobId}`)) return;
    const r = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    if (!r.ok) { alert(`删除失败：HTTP ${r.status}`); return; }
    setJobs(js => js.filter(j => j.job_id !== jobId));
  }

  async function toggleHidden(path: string) {
    const next = !isGalleryHidden(path, hiddenPaths);
    try {
      setHiddenPaths(await setGalleryHidden(path, next));
    } catch {
      alert('切换展示状态失败，稍后再试');
    }
  }

  async function voidStaleJob(jobId: string) {
    if (!window.confirm(`作废这个生成任务？\n${jobId}\n（超过 1 小时未完成，出图进程可能已中断）`)) return;
    const r = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    if (!r.ok) { alert(`作废失败：HTTP ${r.status}`); return; }
    // 后端把超时 pending 标成 failed 留痕；本地同步翻面，变成可删除的失败卡。
    setJobs(js => js.map(j => j.job_id === jobId
      ? { ...j, status: 'failed' as const, error: '已作废：pending 超时，疑似进程中断' }
      : j));
  }

  const colClassMap: Record<number, string> = {
    1: 'columns-1', 2: 'columns-2', 3: 'columns-3', 4: 'columns-4', 5: 'columns-5',
  };
  const colClass = colClassMap[colCount] ?? 'columns-3';
  const hasAny = allImages.length > 0 || isRunning || failedJobs.length > 0;

  return (
    <GalleryShell
      name={characterName} count={allImages.length} rounds={tabJobs.length}
      compact={detailMode} tab={tab} setTab={setTab} tabCounts={tabCounts}
      colCount={colCount} onColCountChange={setColCount}
    >
      <GalleryUpload
        characterId={characterId}
        kind={tab}
        onUploaded={() => setUploadSignal(s => s + 1)}
      />

      {!hasAny && (
        <div className="py-16 text-center">
          <p className="font-[var(--font-display)] italic text-2xl text-foreground/70 mb-2">
            {TAB_META[tab].emptyTitle}
          </p>
          <p className="text-xs text-muted-foreground">
            {TAB_META[tab].emptyHint}
          </p>
        </div>
      )}

      {hasAny && (
        <div className={cn(colClass, 'gap-4')}>
          {allImages.map((img, i) => (
            <figure key={i} className="group relative mb-4 break-inside-avoid">
              <button
                onClick={() => onSelectImage(img.path, img.jobId)}
                className="w-full block overflow-hidden rounded-lg border border-border/50 bg-card transition-all duration-200 hover:border-primary/60 hover:shadow-[0_0_0_1px_var(--primary)] cursor-pointer p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <img
                  src={`/api/raw?path=${encodeURIComponent(img.path)}&job_id=${encodeURIComponent(img.jobId)}`}
                  alt=""
                  className="w-full h-auto block transition-opacity duration-300 group-hover:opacity-95"
                />
              </button>
              <figcaption className="pointer-events-none absolute bottom-2 left-2 font-mono text-[10px] tabular-nums tracking-wider text-foreground bg-background/75 backdrop-blur-sm px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                №{String(i + 1).padStart(2, '0')}
              </figcaption>
              <button
                onClick={(e) => { e.stopPropagation(); void toggleHidden(img.path); }}
                title={isGalleryHidden(img.path, hiddenPaths) ? '已从首页作品展示隐藏，点击恢复' : '从首页作品展示隐藏（工坊内仍可见）'}
                aria-label={isGalleryHidden(img.path, hiddenPaths) ? '恢复展示' : '隐藏'}
                className={cn(
                  'absolute left-2 top-2 size-7 rounded-full bg-black/70 text-white grid place-items-center transition-opacity backdrop-blur-sm hover:bg-black/85 cursor-pointer border-0',
                  // 已隐藏的图常显 EyeOff 作状态标识；未隐藏的悬停才出现，不抢画面。
                  isGalleryHidden(img.path, hiddenPaths) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                {isGalleryHidden(img.path, hiddenPaths)
                  ? <EyeOff className="size-3.5" />
                  : <Eye className="size-3.5" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void deleteImage(img.jobId, img.path); }}
                title="删除这张图"
                aria-label="删除"
                className="absolute right-2 top-2 size-7 rounded-full bg-black/70 text-white grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm hover:bg-destructive cursor-pointer border-0"
              >
                <X className="size-3.5" />
              </button>
            </figure>
          ))}

          {tabJobs.filter(j => j.status === 'pending' && !isStalePending(j)).flatMap(j =>
            Array.from({ length: j.params?.n ?? 1 }, (_, i) => <SkeletonCard key={`${j.job_id}-s${i}`} />)
          )}
          {tabJobs.filter(isStalePending).map(j => (
            <StalePendingCard key={j.job_id} jobId={j.job_id} onVoid={voidStaleJob} />
          ))}
          {failedJobs.map(j => (
            <ErrorCard
              key={j.job_id}
              jobId={j.job_id}
              error={j.error || '未知错误'}
              onDelete={deleteFailedJob}
            />
          ))}
        </div>
      )}
    </GalleryShell>
  );
}

function GalleryShell({
  name, count, rounds, children, compact = false, tab, setTab, tabCounts,
  colCount, onColCountChange,
}: {
  name: string | null; count: number; rounds: number; children: React.ReactNode; compact?: boolean;
  tab: TabKind; setTab: (t: TabKind) => void; tabCounts: Record<TabKind, number>;
  colCount: number; onColCountChange: (n: number) => void;
}) {
  return (
    <main className="flex flex-col h-full overflow-hidden">
      <header className={cn('border-b border-border/40', compact ? 'px-5 pt-5 pb-3' : 'px-8 pt-8 pb-5')}>
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className={cn('uppercase text-muted-foreground/70 mb-1', compact ? 'text-[9px] tracking-[0.2em]' : 'text-[10px] tracking-[0.22em]')}>
              gallery · 角色
            </div>
            <h1 className={cn(
              'font-[var(--font-display)] italic leading-[1.05] tracking-tight text-foreground truncate',
              compact ? 'text-xl' : 'text-[40px]',
            )}>
              {name ?? '—'}
            </h1>
          </div>
          <div className={cn('shrink-0 text-right flex flex-col items-end gap-2 font-mono tabular-nums text-muted-foreground leading-relaxed',
            compact ? 'text-[10px]' : 'text-xs')}>
            {count > 0 && (
              <div className="text-right">
                <div><span className="text-foreground/85">{count}</span> 图</div>
                <div><span className="text-foreground/85">{rounds}</span> 轮</div>
              </div>
            )}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-muted-foreground/60">⊞</span>
              <input
                type="range"
                min={1}
                max={5}
                value={colCount}
                onChange={e => onColCountChange(Number(e.target.value))}
                className="w-20 accent-primary"
                aria-label="调整列数"
              />
              <span className="text-muted-foreground/60 w-3">{colCount}</span>
            </label>
          </div>
        </div>
        <TabStrip tab={tab} setTab={setTab} counts={tabCounts} compact={compact} />
      </header>
      <div className={cn('flex-1 overflow-y-auto', compact ? 'px-4 py-4' : 'px-8 py-6')}>
        {children}
      </div>
    </main>
  );
}

function TabStrip({
  tab, setTab, counts, compact,
}: { tab: TabKind; setTab: (t: TabKind) => void; counts: Record<TabKind, number>; compact: boolean }) {
  const tabs: { key: TabKind; label: string }[] = (Object.keys(TAB_META) as TabKind[])
    .map(k => ({ key: k, label: TAB_META[k].label }));
  return (
    <div className={cn('flex items-baseline gap-5 mt-3', compact && 'mt-2')}>
      {tabs.map(t => {
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'group relative bg-transparent border-0 p-0 cursor-pointer rounded-sm',
              'flex items-baseline gap-1.5 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/80',
            )}
          >
            <span className={cn(
              'font-[var(--font-display)] italic',
              compact ? 'text-sm' : 'text-base',
            )}>{t.label}</span>
            <span className="font-mono tabular-nums text-[10px] text-muted-foreground/70">
              {counts[t.key]}
            </span>
            {active && (
              <span className="absolute -bottom-[6px] left-0 right-0 h-px bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function GalleryUpload({
  characterId, kind, onUploaded,
}: { characterId: string; kind: TabKind; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/characters/${characterId}/gallery/${kind}`, { method: 'POST', body: fd });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error((d as { detail?: string }).detail || `HTTP ${r.status}`);
      }
      onUploaded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 flex items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="shrink-0"
      >
        <Upload className="size-3.5" />
        {busy ? '上传中…' : '添加图片'}
      </Button>
      {error && (
        <span className="text-xs text-destructive flex items-center gap-1">
          <AlertTriangle className="size-3 shrink-0" />
          {error}
        </span>
      )}
    </div>
  );
}

function EmptyShell({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <main className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="space-y-3">
        <p className="font-[var(--font-display)] italic text-[40px] leading-[1.1] text-foreground/75">
          {title}
        </p>
        {subtitle && (
          <p className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground/70">
            {subtitle}
          </p>
        )}
      </div>
    </main>
  );
}

function Skeleton({ cols }: { cols: number }) {
  const colClassMap: Record<number, string> = {
    1: 'columns-1', 2: 'columns-2', 3: 'columns-3', 4: 'columns-4', 5: 'columns-5',
  };
  const colClass = colClassMap[cols] ?? 'columns-3';
  return (
    <div className={cn(colClass, 'gap-4')}>
      {Array.from({ length: cols }).map((_, i) => <SkeletonCard key={i} loading />)}
    </div>
  );
}

// loading=true：画廊正在加载已有内容（中性微光占位，不显示“生成中”，避免误以为在出图）。
// loading=false：确有 pending job 正在出图，显示“生成中…”。
function SkeletonCard({ loading = false }: { loading?: boolean }) {
  return (
    <div className="relative h-52 mb-4 break-inside-avoid overflow-hidden rounded-lg border border-border/40 bg-card animate-pulse">
      {!loading && (
        <div className="absolute bottom-3 left-3 flex items-center gap-1.5 text-xs text-[color:var(--status-running)]">
          <Loader2 className="size-3 animate-spin" />
          生成中…
        </div>
      )}
    </div>
  );
}

// pending 超时（疑似 Skill 进程已死）—— 不再转圈误导“还在生成”，给作废出口。
function StalePendingCard({ jobId, onVoid }: { jobId: string; onVoid: (jobId: string) => void }) {
  return (
    <div
      data-testid={`stale-pending-${jobId}`}
      className="relative flex h-48 mb-4 break-inside-avoid flex-col items-center justify-center gap-2 rounded-lg border border-border/60 bg-card p-3 text-center"
    >
      <AlertTriangle className="size-7 text-muted-foreground" />
      <div className="text-xs text-muted-foreground font-medium">可能已中断</div>
      <p className="text-[10px] text-muted-foreground/70">超过 1 小时未完成，出图进程可能已退出</p>
      <button
        onClick={() => onVoid(jobId)}
        className="text-xs text-primary hover:underline cursor-pointer bg-transparent border-0 p-0"
      >
        [作废]
      </button>
    </div>
  );
}

function ErrorCard({ jobId, error, onDelete }: { error: string; jobId: string; onDelete: (jobId: string) => void }) {
  return (
    <div
      title={error}
      className="group relative flex h-48 mb-4 break-inside-avoid flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-center"
    >
      <button
        onClick={() => onDelete(jobId)}
        title="删除这个失败记录"
        aria-label="删除"
        className="absolute right-2 top-2 size-7 rounded-full bg-black/70 text-white grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm hover:bg-destructive cursor-pointer border-0"
      >
        <X className="size-3.5" />
      </button>
      <AlertTriangle className="size-7 text-destructive" />
      <div className="text-xs text-destructive font-medium">出图失败</div>
      <button
        onClick={() => alert(`重试 ${jobId}：复制 prompt 后 Cmd+V`)}
        className="text-xs text-primary hover:underline cursor-pointer bg-transparent border-0 p-0"
      >
        [重试]
      </button>
    </div>
  );
}
