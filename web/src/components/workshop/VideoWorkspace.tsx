import { useState } from 'react';
import { Check, Film } from 'lucide-react';
import { Link } from 'wouter';

import type {
  ProjectVideoJobRecord,
  ProjectVideoProduction,
  ProjectVideoReferenceCandidate,
  ProjectVideoShot,
} from '@/api/videos';
import { cn } from '@/lib/utils';
import { useWorkshopReturn, withWorkshopReturn } from '@/lib/workshopReturn';

export function VideoWorkspace({
  projectId,
  productionId,
  shotId,
  productions,
  referenceCandidates,
  onSelected,
  onReferences,
}: {
  projectId: string;
  productionId?: string;
  shotId?: string;
  productions: ProjectVideoProduction[];
  referenceCandidates: ProjectVideoReferenceCandidate[];
  onSelected: (productionId: string, shotId: string, path: string | null) => Promise<void>;
  onReferences: (productionId: string, shotId: string, paths: string[]) => Promise<void>;
}) {
  if (productions.length === 0) return <VideoEmpty />;
  const current = productionId
    ? productions.find(production => production.production_id === productionId)
    : undefined;
  if (productionId && !current) {
    return <p className="text-sm text-muted-foreground">找不到视频企划 {productionId}。</p>;
  }
  if (!current) return <ProductionList projectId={projectId} productions={productions} />;
  const shot = shotId ? current.shots.find(item => item.shot_id === shotId) : undefined;
  if (shotId && !shot) return <p className="text-sm text-muted-foreground">找不到镜头 {shotId}。</p>;
  return shot ? (
    <ShotDetail
      projectId={projectId}
      production={current}
      shot={shot}
      referenceCandidates={referenceCandidates}
      onSelected={onSelected}
      onReferences={onReferences}
    />
  ) : (
    <ProductionDetail projectId={projectId} production={current} />
  );
}

function ProductionList({ projectId, productions }: {
  projectId: string;
  productions: ProjectVideoProduction[];
}) {
  const returnContext = useWorkshopReturn();
  return (
    <section className="space-y-4" data-testid="project-videos">
      <div>
        <p className="text-xs uppercase tracking-label text-muted-foreground/70">Video Productions</p>
        <h2 className="mt-2 font-display text-display italic text-foreground">视频企划</h2>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card/30">
        {productions.map(production => {
          const selected = production.shots.filter(shot => shot.selected).length;
          return (
            <Link
              key={production.production_id}
              href={withWorkshopReturn(`/workshop/${encodeURIComponent(projectId)}/video/${encodeURIComponent(production.production_id)}`, returnContext)}
              className="grid gap-2 px-4 py-4 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:grid-cols-[minmax(160px,0.8fr)_minmax(180px,1fr)_auto] sm:items-center"
            >
              <div>
                <p className="text-base font-medium text-foreground">{production.title}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{production.production_id} · {production.type}</p>
              </div>
              <p className="text-xs text-muted-foreground">{production.brief.goal || '尚未填写企划目标'}</p>
              <span className="font-mono text-xs text-muted-foreground">{selected}/{production.shots.length} 镜头选版</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function ProductionDetail({ projectId, production }: {
  projectId: string;
  production: ProjectVideoProduction;
}) {
  const returnContext = useWorkshopReturn();
  return (
    <section className="space-y-6" data-testid="project-videos">
      <div className="space-y-2">
        <Link href={withWorkshopReturn(`/workshop/${encodeURIComponent(projectId)}/video`, returnContext)} className="text-xs text-muted-foreground hover:text-foreground">
          视频 / 企划列表
        </Link>
        <h2 className="font-display text-display italic text-foreground">{production.title}</h2>
        <p className="font-mono text-xs text-muted-foreground">{production.production_id} · {production.type} · {production.status}</p>
        <BriefSummary production={production} />
      </div>
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-medium text-foreground">镜头板</h3>
          <span className="font-mono text-xs text-muted-foreground">{production.shots.length} 镜头</span>
        </div>
        {production.shots.length > 0 ? (
          <ol className="divide-y divide-border rounded-lg border border-border bg-card/30">
            {production.shots.map((shot, index) => (
              <li key={shot.shot_id}>
                <Link
                  href={withWorkshopReturn(`/workshop/${encodeURIComponent(projectId)}/video/${encodeURIComponent(production.production_id)}/shots/${encodeURIComponent(shot.shot_id)}`, returnContext)}
                  className="grid gap-2 px-4 py-3 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:grid-cols-[48px_minmax(140px,0.7fr)_minmax(180px,1fr)_auto] sm:items-center"
                >
                  <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <p className="font-mono text-sm text-foreground">{shot.shot_id}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{shot.duration || '时长未定'}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">{shot.purpose || '尚未填写镜头用途'}</p>
                  <span className={cn('text-xs', shot.selected ? 'text-primary' : 'text-muted-foreground')}>
                    {shot.selected ? '已选版' : shot.versions.length ? '待选版' : shot.status}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-lg border border-border bg-card/30 px-4 py-8 text-center text-sm text-muted-foreground">镜头表尚未填写。</p>
        )}
      </div>
      {production.exports.length > 0 && <ExportList paths={production.exports} />}
    </section>
  );
}

function ShotDetail({
  projectId,
  production,
  shot,
  referenceCandidates,
  onSelected,
  onReferences,
}: {
  projectId: string;
  production: ProjectVideoProduction;
  shot: ProjectVideoShot;
  referenceCandidates: ProjectVideoReferenceCandidate[];
  onSelected: (productionId: string, shotId: string, path: string | null) => Promise<void>;
  onReferences: (productionId: string, shotId: string, paths: string[]) => Promise<void>;
}) {
  const returnContext = useWorkshopReturn();
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [savingReferences, setSavingReferences] = useState(false);

  async function selectVersion(path: string, selected: boolean) {
    setSelecting(path);
    setSelectionError(null);
    try {
      await onSelected(production.production_id, shot.shot_id, selected ? null : path);
    } catch {
      setSelectionError('选版失败，请稍后再试。');
    } finally {
      setSelecting(null);
    }
  }

  async function toggleReference(path: string) {
    const selected = shot.planned_reference_images ?? [];
    const next = selected.includes(path)
      ? selected.filter(item => item !== path)
      : [...selected, path];
    setSavingReferences(true);
    setSelectionError(null);
    try {
      await onReferences(production.production_id, shot.shot_id, next);
    } catch {
      setSelectionError('保存参考素材失败，请稍后再试。');
    } finally {
      setSavingReferences(false);
    }
  }

  return (
    <section className="space-y-5" data-testid="project-videos">
      <div className="space-y-2">
        <Link href={withWorkshopReturn(`/workshop/${encodeURIComponent(projectId)}/video/${encodeURIComponent(production.production_id)}`, returnContext)} className="text-xs text-muted-foreground hover:text-foreground">
          视频 / {production.title} / 镜头板
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-display text-display italic text-foreground">{shot.shot_id}</h2>
            {shot.purpose && <p className="mt-2 text-sm text-muted-foreground">{shot.purpose}</p>}
          </div>
          <span className="text-xs text-muted-foreground">{shot.duration || '时长未定'} · {shot.status}</span>
        </div>
      </div>
      <ReferenceSelector
        candidates={referenceCandidates}
        selectedPaths={shot.planned_reference_images ?? []}
        disabled={savingReferences}
        onToggle={(path) => { void toggleReference(path); }}
      />
      <JobHistory records={shot.history} />
      {selectionError && <p role="status" className="text-xs text-destructive">{selectionError}</p>}
      {shot.versions.length > 0 ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {shot.versions.map(path => {
            const selected = shot.selected === path;
            return (
              <figure key={path} className="w-72 shrink-0 space-y-2">
                <video
                  src={`/api/gallery/image?path=${encodeURIComponent(path)}`}
                  controls
                  preload="metadata"
                  className="aspect-video w-full rounded-lg border border-border bg-background object-cover"
                />
                <figcaption className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-muted-foreground">{filename(path)}</span>
                  <button
                    type="button"
                    onClick={() => void selectVersion(path, selected)}
                    disabled={selecting !== null}
                    aria-label={selected ? `取消选用 ${shot.shot_id} ${filename(path)}` : `选用 ${shot.shot_id} ${filename(path)}`}
                    className={cn(
                      'shrink-0 rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      selected ? 'border-primary/60 text-primary' : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    {selecting === path ? '处理中…' : selected ? '已选用' : '选用'}
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : (
        <div className="grid min-h-[240px] place-items-center rounded-lg border border-border bg-card/30 text-center">
          <p className="text-sm text-muted-foreground">这个镜头尚未生成版本。</p>
        </div>
      )}
    </section>
  );
}

function ReferenceSelector({
  candidates,
  selectedPaths,
  disabled,
  onToggle,
}: {
  candidates: ProjectVideoReferenceCandidate[];
  selectedPaths: string[];
  disabled: boolean;
  onToggle: (path: string) => void;
}) {
  const visibleCandidates: Array<Pick<
    ProjectVideoReferenceCandidate,
    'path' | 'label' | 'detail' | 'stale'
  >> = [
    ...candidates,
    ...selectedPaths
      .filter(path => !candidates.some(candidate => candidate.path === path))
      .map(path => ({
        label: filename(path),
        detail: '已选明确版本（不再是当前定稿）',
        path,
        stale: true,
      })),
  ];
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card/30 p-4" aria-label="镜头参考素材">
      <div>
        <h3 className="text-base font-medium text-foreground">下一次生成的参考素材</h3>
        <p className="mt-1 text-xs text-muted-foreground">直接选择项目里的角色、皮肤和 UI 页面定稿。生成时会把实际路径写入 Job 历史。</p>
      </div>
      {visibleCandidates.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {visibleCandidates.map(candidate => {
            const selected = selectedPaths.includes(candidate.path);
            return (
              <button
                key={candidate.path}
                type="button"
                aria-label={`${selected ? '取消参考' : '选择参考'} ${candidate.label}`}
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onToggle(candidate.path)}
                className={cn(
                  'w-40 shrink-0 overflow-hidden rounded-lg border bg-background text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  selected ? 'border-primary/60' : 'border-border hover:bg-secondary/40',
                )}
              >
                <div className="relative aspect-video overflow-hidden border-b border-border bg-card">
                  <img
                    src={`/api/gallery/image?path=${encodeURIComponent(candidate.path)}`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  {selected && (
                    <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-4" aria-hidden />
                    </span>
                  )}
                </div>
                <span className="block p-3">
                  <span className="block truncate text-sm font-medium text-foreground">{candidate.label}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{candidate.detail}</span>
                  {candidate.stale && <span className="mt-1 block text-xs text-[color:var(--status-running)]">定稿已过时</span>}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">项目里还没有可引用的角色或 UI 定稿。</p>
      )}
    </section>
  );
}

function BriefSummary({ production }: { production: ProjectVideoProduction }) {
  const fields = [
    ['目标', production.brief.goal],
    ['平台', production.brief.platform],
    ['画幅', production.brief.ratio],
    ['时长', production.brief.duration],
    ['声音', production.brief.sound],
  ].filter(([, value]) => value);
  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">尚未填写企划 Brief。</p>;
  }
  return (
    <dl className="grid gap-x-4 gap-y-2 rounded-lg border border-border bg-card/30 p-4 sm:grid-cols-[72px_1fr]">
      {fields.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-sm text-foreground/85">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function JobHistory({ records }: { records: ProjectVideoJobRecord[] }) {
  if (records.length === 0) return null;
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card/30 p-4">
      <h3 className="text-base font-medium text-foreground">生成历史</h3>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {records.map(record => (
          <article key={record.job_id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-xs text-muted-foreground">
                {record.model} · {record.status} · {formatDate(record.submitted_at)}
              </p>
              <span className="font-mono text-xs text-muted-foreground/70">{record.job_id}</span>
            </div>
            {record.prompt && (
              <div className="space-y-1.5">
                <p className="text-xs text-foreground/75">生成提示词</p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{record.prompt}</p>
              </div>
            )}
            <JobParameters record={record} />
            <ReferenceAssets record={record} />
          </article>
        ))}
      </div>
    </section>
  );
}

function JobParameters({ record }: { record: ProjectVideoJobRecord }) {
  const fields = [
    ['时长', record.params.duration ? `${record.params.duration}s` : ''],
    ['分辨率', record.params.resolution ?? ''],
    ['画幅', record.params.ratio ?? ''],
    ['帧模式', record.params.frame_mode ?? ''],
    ['声音', typeof record.params.generate_audio === 'boolean' ? (record.params.generate_audio ? '生成' : '不生成') : ''],
  ].filter(([, value]) => value) as Array<[string, string]>;
  if (fields.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {fields.map(([label, value]) => (
        <div key={label} className="flex gap-1">
          <dt>{label}</dt>
          <dd className="font-mono text-foreground/75">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReferenceAssets({ record }: { record: ProjectVideoJobRecord }) {
  const groups = [
    ['参考图', record.params.reference_images ?? []],
    ['参考视频', record.params.reference_videos ?? []],
    ['参考音频', record.params.reference_audios ?? []],
  ].filter(([, paths]) => (paths as string[]).length > 0) as Array<[string, string[]]>;
  if (groups.length === 0) return null;
  const rawSource = (path: string) => `/api/raw?job_id=${encodeURIComponent(record.job_id)}&path=${encodeURIComponent(path)}`;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      {groups.map(([label, paths]) => (
        <div key={label} className="grid gap-2 sm:grid-cols-[72px_1fr]">
          <p className="text-xs text-muted-foreground">{label}</p>
          <div className="flex flex-wrap gap-2">
            {paths.map(path => label === '参考图' ? (
              <figure key={path} className="w-24 space-y-1">
                <img src={rawSource(path)} alt={filename(path)} className="aspect-video w-full rounded-md border border-border object-cover" />
                <figcaption className="truncate font-mono text-xs text-foreground/75">{filename(path)}</figcaption>
              </figure>
            ) : (
              <span key={path} className="break-all font-mono text-xs text-foreground/75">{filename(path)}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function ExportList({ paths }: { paths: string[] }) {
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <p className="text-xs uppercase tracking-label text-muted-foreground/70">成片</p>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {paths.map(path => (
          <video
            key={path}
            src={`/api/gallery/image?path=${encodeURIComponent(path)}`}
            controls
            preload="metadata"
            className="aspect-video w-72 shrink-0 rounded-lg border border-border bg-background object-cover"
          />
        ))}
      </div>
    </section>
  );
}

function VideoEmpty() {
  return (
    <section className="grid min-h-[360px] place-items-center rounded-lg border border-border bg-card/30 px-6 text-center">
      <div className="max-w-lg space-y-4">
        <Film className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <div className="space-y-2">
          <h2 className="font-display text-display italic text-foreground/70">这个项目还没有视频企划</h2>
          <p className="text-sm text-muted-foreground">用视频总控建立 brief 与镜头表，生成结果会按企划和镜头归档在这里。</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <code className="inline-flex rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">/game-atelier:video</code>
          <Link href="/studio" className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            去创作台试验视频
          </Link>
        </div>
      </div>
    </section>
  );
}

function filename(path: string): string {
  return path.split('/').at(-1) ?? path;
}
