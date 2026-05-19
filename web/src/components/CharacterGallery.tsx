import { useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, Loader2, Upload, ClipboardCopy, Clock } from 'lucide-react';
import type { Job, JobKind } from '../schema/jobs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  characterId: string | null;
  characterName: string | null;
  detailMode: boolean;
  onSelectImage: (path: string, jobId: string) => void;
  sseSignal: number;
}

type TabKind = 'portrait' | 'promo' | 'turnaround';

const TAB_META: Record<TabKind, {
  label: string;
  emptyTitle: string;
  emptyHint: string;
  // 控制台标题 / 触发命令前缀；portrait 不显示 launchpad
  launchpad?: { title: string; command: string };
}> = {
  portrait: {
    label: '立绘',
    emptyTitle: '等待第一张作品',
    emptyHint: '保存档案后将触发首轮出图',
  },
  promo: {
    label: '美宣',
    emptyTitle: '等待第一张美宣',
    emptyHint: '上传源图后复制命令到 CC 触发 /character-promo',
    launchpad: { title: '美宣出图 · 控制台', command: '/character-promo' },
  },
  turnaround: {
    label: '三视图',
    emptyTitle: '等待第一张三视图',
    emptyHint: '上传源图后复制命令到 CC 触发 /character-turnaround',
    launchpad: { title: '三视图出图 · 控制台', command: '/character-turnaround' },
  },
};

export function CharacterGallery({ characterId, characterName, detailMode, onSelectImage, sseSignal }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<TabKind>('portrait');

  useEffect(() => {
    if (!characterId) return;
    setLoading(true);
    fetch(`/api/jobs`)
      .then(r => r.json() as Promise<Job[]>)
      .then(all => setJobs(all.filter(j => j.character_id === characterId)))
      .finally(() => setLoading(false));
  }, [characterId, sseSignal]);

  if (!characterId) return <EmptyShell title="请在左栏选择角色" subtitle="Atelier · 角色资产工坊" />;

  // 旧 job 无 kind 字段时按 PORTRAIT 处理（后端 Pydantic 默认值，前端二次兜底防漂移）
  const jobKind = (j: Job): JobKind => j.kind ?? 'portrait';
  const tabJobs = jobs.filter(j => jobKind(j) === tab);
  const tabCounts: Record<TabKind, number> = {
    portrait: jobs.filter(j => jobKind(j) === 'portrait').length,
    promo: jobs.filter(j => jobKind(j) === 'promo').length,
    turnaround: jobs.filter(j => jobKind(j) === 'turnaround').length,
  };

  if (loading && jobs.length === 0) {
    return (
      <GalleryShell name={characterName} count={0} rounds={0} compact={detailMode}
        tab={tab} setTab={setTab} tabCounts={tabCounts}>
        <Skeleton cols={detailMode ? 2 : 3} />
      </GalleryShell>
    );
  }

  const allImages: { path: string; jobId: string; status: Job['status'] }[] = [];
  tabJobs.forEach(j => j.output_paths.forEach(p => allImages.push({ path: p, jobId: j.job_id, status: j.status })));
  const failedJobs = tabJobs.filter(j => j.status === 'failed');
  const isRunning = tabJobs.some(j => j.status === 'pending');
  const pendingConfirm = tabJobs.filter(j => j.status === 'pending_confirm');

  async function deleteImage(jobId: string, path: string) {
    if (!window.confirm(`删除这张图？\n${path}\n（磁盘文件也会删，不可恢复）`)) return;
    const r = await fetch(`/api/jobs/${jobId}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!r.ok) { alert(`删除失败：HTTP ${r.status}`); return; }
    setJobs(js => js.map(j => j.job_id === jobId
      ? { ...j, output_paths: j.output_paths.filter(p => p !== path) }
      : j));
  }

  const cols = detailMode ? 2 : 3;
  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-3';
  const hasAny = allImages.length > 0 || isRunning || failedJobs.length > 0 || pendingConfirm.length > 0;

  return (
    <GalleryShell
      name={characterName} count={allImages.length} rounds={tabJobs.length}
      compact={detailMode} tab={tab} setTab={setTab} tabCounts={tabCounts}
    >
      {TAB_META[tab].launchpad && (
        <SkillLaunchpad
          characterId={characterId}
          title={TAB_META[tab].launchpad!.title}
          command={TAB_META[tab].launchpad!.command}
        />
      )}

      {pendingConfirm.length > 0 && <PendingConfirmBadge jobs={pendingConfirm} />}

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
        <div className={cn('grid gap-4', gridCols)}>
          {allImages.map((img, i) => (
            <figure key={i} className="group relative aspect-square">
              <button
                onClick={() => onSelectImage(img.path, img.jobId)}
                className="size-full overflow-hidden rounded-lg border border-border/50 bg-card transition-all duration-200 hover:border-primary/60 hover:shadow-[0_0_0_1px_var(--primary)] cursor-pointer p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <img
                  src={`/api/raw?path=${encodeURIComponent(img.path)}&job_id=${encodeURIComponent(img.jobId)}`}
                  alt=""
                  className="size-full object-cover transition-opacity duration-300 group-hover:opacity-95"
                />
              </button>
              <figcaption className="pointer-events-none absolute bottom-2 left-2 font-mono text-[10px] tabular-nums tracking-wider text-foreground bg-background/75 backdrop-blur-sm px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                №{String(i + 1).padStart(2, '0')}
              </figcaption>
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

          {isRunning && Array.from({ length: 2 }).map((_, i) => <SkeletonCard key={`s${i}`} />)}
          {failedJobs.map(j => <ErrorCard key={j.job_id} jobId={j.job_id} error={j.error || '未知错误'} />)}
        </div>
      )}
    </GalleryShell>
  );
}

function GalleryShell({
  name, count, rounds, children, compact = false, tab, setTab, tabCounts,
}: {
  name: string | null; count: number; rounds: number; children: React.ReactNode; compact?: boolean;
  tab: TabKind; setTab: (t: TabKind) => void; tabCounts: Record<TabKind, number>;
}) {
  return (
    <main className="flex flex-col h-screen overflow-hidden">
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
          {count > 0 && (
            <div className={cn('shrink-0 text-right font-mono tabular-nums text-muted-foreground leading-relaxed',
              compact ? 'text-[10px]' : 'text-xs')}>
              <div><span className="text-foreground/85">{count}</span> 图</div>
              <div><span className="text-foreground/85">{rounds}</span> 轮</div>
            </div>
          )}
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
              'group relative bg-transparent border-0 p-0 cursor-pointer',
              'flex items-baseline gap-1.5 transition-colors',
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

function SkillLaunchpad({
  characterId, title, command: commandPrefix,
}: { characterId: string; title: string; command: string }) {
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const command = uploadedPath
    ? `${commandPrefix} ${characterId} --upload ${uploadedPath}`
    : `${commandPrefix} ${characterId}`;

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/uploads', { method: 'POST', body: fd });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setUploadedPath(data.path);
      setUploadedName(data.filename);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard 不可用时退化为提示用户手动复制
      setError('复制失败，请手动选中命令字符串');
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-border/50 bg-card/50 p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-[var(--font-display)] italic text-lg text-foreground">{title}</h2>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          web 不直接触发 · 复制命令到 CC
        </span>
      </div>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">源图（可选）</div>
        <div className="flex items-center gap-3">
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
          >
            <Upload className="size-3.5" />
            {busy ? '上传中…' : uploadedPath ? '换一张' : '选择文件'}
          </Button>
          {uploadedName && (
            <div className="min-w-0 text-xs text-muted-foreground">
              <div className="truncate text-foreground/85">{uploadedName}</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground/70">{uploadedPath}</div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">触发命令</div>
        <div className="flex items-center gap-2">
          <pre className="flex-1 m-0 px-3 py-2 rounded border border-border/50 bg-background font-mono text-xs text-foreground/90 overflow-x-auto whitespace-nowrap">
            {command}
          </pre>
          <Button size="sm" onClick={copyCommand}>
            <ClipboardCopy className="size-3.5" />
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-destructive flex items-center gap-1.5">
          <AlertTriangle className="size-3.5" />
          {error}
        </div>
      )}
    </div>
  );
}

function EmptyShell({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <main className="flex h-screen flex-col items-center justify-center px-8 text-center">
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
  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-3';
  return (
    <div className={cn('grid gap-4', gridCols)}>
      {Array.from({ length: cols * 2 }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="relative aspect-square overflow-hidden rounded-lg border border-border/40 bg-card animate-pulse">
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 text-xs text-[color:var(--status-running)]">
        <Loader2 className="size-3 animate-spin" />
        生成中…
      </div>
    </div>
  );
}

function PendingConfirmBadge({ jobs }: { jobs: Job[] }) {
  // 决策面是终端，Web 只显示存在感 —— 不放确认/取消按钮，不渲染 prompt / 参数细节
  return (
    <div className="mb-6 rounded-md border border-[color:var(--status-running)]/40 bg-[color:var(--status-running)]/[0.06] px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2.5 text-[color:var(--status-running)] min-w-0">
        <Clock className="size-3.5 shrink-0" />
        <span className="font-[var(--font-display)] italic text-sm">
          {jobs.length} 个 job 等终端确认
        </span>
      </div>
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 shrink-0">
        去 CC 跟 Claude 说「出图」或「取消」
      </span>
    </div>
  );
}

function ErrorCard({ jobId }: { error: string; jobId: string }) {
  return (
    <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-center">
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
