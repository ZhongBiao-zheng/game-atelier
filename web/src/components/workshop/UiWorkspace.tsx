import { useState } from 'react';
import { BadgeCheck, Check, Copy, PanelsTopLeft } from 'lucide-react';
import { Link } from 'wouter';

import { isCanonicalPath, setScreenCanonical } from '@/api/canonical';
import type { ProjectScreenItem } from '@/api/gallery';
import type { ProjectWorkspaceSummary, UiScreenSummary } from '@/api/workspaces';
import type { ScreenCanonicalFile } from '@/schema/jobs';
import { cn } from '@/lib/utils';

export function UiWorkspace({
  projectId,
  screenId,
  summary,
  screens,
  canonicalFile,
  onCanonicalChange,
}: {
  projectId: string;
  screenId?: string;
  summary: ProjectWorkspaceSummary['ui'] | null;
  screens: ProjectScreenItem[];
  canonicalFile: ScreenCanonicalFile;
  onCanonicalChange: (file: ScreenCanonicalFile) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const groups = groupScreens(screens);
  const currentImages = screenId ? groups.find(([id]) => id === screenId)?.[1] ?? [] : [];
  const current = summary?.screen_items.find(item => item.screen_id === screenId);
  const currentCanonical = screenId ? canonicalFile.screens[screenId] : undefined;

  async function toggleCanonical(id: string, path: string) {
    const entry = canonicalFile.screens[id];
    try {
      onCanonicalChange(await setScreenCanonical(
        projectId,
        id,
        isCanonicalPath(path, entry) ? null : path,
      ));
    } catch {
      setMessage('切换定稿失败，稍后再试');
    }
  }

  if (!summary && screens.length === 0) return <UiEmpty />;

  return (
    <div className="space-y-6">
      <UiWorkflowStrip summary={summary} hasScreens={screens.length > 0} />
      {message && <p role="status" className="text-xs text-destructive">{message}</p>}
      {screenId ? (
        <ScreenDetail
          projectId={projectId}
          screenId={screenId}
          item={current}
          images={currentImages}
          canonicalFile={canonicalFile}
          effectiveStatus={effectiveScreenStatus(current?.status, currentImages, currentCanonical)}
          onToggleCanonical={toggleCanonical}
        />
      ) : (
        <ScreenMap
          projectId={projectId}
          items={summary?.screen_items ?? []}
          groups={groups}
          canonicalFile={canonicalFile}
        />
      )}
    </div>
  );
}

function UiWorkflowStrip({
  summary,
  hasScreens,
}: {
  summary: ProjectWorkspaceSummary['ui'] | null;
  hasScreens: boolean;
}) {
  const steps = workflowSteps(summary, hasScreens);
  const [copied, setCopied] = useState(false);
  const command = summary?.next_command ?? '/game-atelier:ui';
  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <section aria-label="UI 工作流" className="space-y-4 rounded-lg border border-border bg-card/30 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-label text-muted-foreground/70">UI Workflow</p>
          <h2 className="mt-2 text-base font-medium text-foreground">
            下一步：{summary?.next_action ?? (hasScreens ? '继续完善页面工作流' : '建立 UI 策划锚')}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void copyCommand()}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? '已复制' : command}
        </button>
      </div>
      <ol className="flex max-w-full gap-2 overflow-x-auto pb-1">
        {steps.map((step, index) => (
          <li key={step.label} className="shrink-0 rounded-md border border-border bg-background/30 px-3 py-2">
            <p className="text-xs text-foreground">{index + 1}. {step.label}</p>
            <p className={cn(
              'mt-1 text-xs',
              step.state === '已完成' ? 'text-primary' :
                step.state === '已过时' ? 'text-destructive' : 'text-muted-foreground',
            )}>
              {step.state}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function workflowSteps(summary: ProjectWorkspaceSummary['ui'] | null, hasScreens: boolean) {
  if (!summary) {
    return [
      { label: '策划锚', state: hasScreens ? '已完成' : '未开始' },
      { label: 'UI 规范', state: hasScreens ? '已完成' : '未开始' },
      { label: '基准页', state: hasScreens ? '已完成' : '未开始' },
      { label: '风格定稿', state: '未开始' },
      { label: '页面地图', state: '未开始' },
      { label: '逐页生成', state: hasScreens ? '进行中' : '未开始' },
    ];
  }
  const anchorValues = Object.values(summary.anchors);
  const anchorState = summary.anchors_approved === 3
    ? '已完成'
    : anchorValues.every(value => value === 'missing') ? '未开始' : '草稿';
  const styleState = summary.style_status === 'approved' && summary.has_ui_style
    ? '已完成'
    : summary.style_status === 'missing' ? '未开始' : '草稿';
  const canonicalState = summary.stale > 0
    ? '已过时'
    : summary.canonical > 0 ? '已完成' : '未开始';
  return [
    { label: '策划锚', state: anchorState },
    { label: 'UI 规范', state: styleState },
    { label: '基准页', state: summary.versions > 0 ? '已完成' : '未开始' },
    { label: '风格定稿', state: canonicalState },
    {
      label: '页面地图',
      state: summary.screen_map_status === 'approved'
        ? '已完成' : summary.screen_map_status === 'missing' ? '未开始' : '草稿',
    },
    {
      label: '逐页生成',
      state: summary.screens > 0
        && summary.canonical >= summary.screens
        && summary.stale === 0
        ? '已完成'
        : summary.versions > 0 ? '进行中' : '未开始',
    },
  ];
}

function ScreenMap({
  projectId,
  items,
  groups,
  canonicalFile,
}: {
  projectId: string;
  items: UiScreenSummary[];
  groups: Array<[string, ProjectScreenItem[]]>;
  canonicalFile: ScreenCanonicalFile;
}) {
  const rows = items.length > 0
    ? items
    : groups.map(([screenId, images]) => ({
        screen_id: screenId,
        name: screenId,
        category: '',
        priority: '',
        status: images.length > 0 ? 'generated' : 'planned',
        dependency: '',
        purpose: '',
      }));
  if (rows.length === 0) return <UiEmpty />;
  return (
    <section className="space-y-3" aria-label="页面地图">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium text-foreground/85">页面地图</h2>
        <span className="font-mono text-xs text-muted-foreground">{rows.length} 页</span>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card/30">
        {rows.map(item => (
          <Link
            key={item.screen_id}
            href={`/workshop/${encodeURIComponent(projectId)}/ui/screens/${encodeURIComponent(item.screen_id)}`}
            className="grid gap-2 px-4 py-3 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:grid-cols-[minmax(140px,0.7fr)_minmax(180px,1fr)_auto] sm:items-center"
          >
            <div>
              <p className="text-sm font-medium text-foreground">{item.name || item.screen_id}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{item.screen_id}</p>
            </div>
            <p className="text-xs text-muted-foreground">{item.purpose || item.category || '尚未填写页面目的'}</p>
            <span className="text-xs text-muted-foreground">
              {screenStatusLabel(effectiveScreenStatus(
                item.status,
                groups.find(([id]) => id === item.screen_id)?.[1] ?? [],
                canonicalFile.screens[item.screen_id],
              ))}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function ScreenDetail({
  projectId,
  screenId,
  item,
  images,
  canonicalFile,
  effectiveStatus,
  onToggleCanonical,
}: {
  projectId: string;
  screenId: string;
  item?: UiScreenSummary;
  images: ProjectScreenItem[];
  canonicalFile: ScreenCanonicalFile;
  effectiveStatus: string;
  onToggleCanonical: (screenId: string, path: string) => Promise<void>;
}) {
  return (
    <section className="space-y-5" data-testid="project-screens">
      <div className="space-y-2">
        <Link href={`/workshop/${encodeURIComponent(projectId)}/ui`} className="text-xs text-muted-foreground hover:text-foreground">
          UI / 页面地图
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-display text-display italic text-foreground">{item?.name || screenId}</h2>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{screenId}</p>
          </div>
          <span className="text-xs text-muted-foreground">{screenStatusLabel(effectiveStatus)}</span>
        </div>
        {item?.purpose && <p className="text-sm text-muted-foreground">{item.purpose}</p>}
        {item?.brief_summary && (
          <p className="rounded-md border-l-2 border-primary/50 bg-card/30 px-3 py-2 text-sm text-muted-foreground">
            {item.brief_summary}
          </p>
        )}
        {canonicalFile.screens[screenId]?.style_stale && (
          <p className="text-xs text-destructive">
            过时原因：当前 style.md 已变更，这个定稿仍基于旧风格指纹。
          </p>
        )}
      </div>
      {images.length > 0 ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {images.map(image => {
            const entry = canonicalFile.screens[screenId];
            const canonical = isCanonicalPath(image.path, entry);
            return (
              <figure key={image.path} className="w-64 shrink-0 space-y-2">
                <div className="group relative overflow-hidden rounded-2xl">
                  <a
                    href={`/api/gallery/image?path=${encodeURIComponent(image.path)}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`查看页面 ${screenId} 的 ${image.filename}`}
                    className="block"
                  >
                    <img
                      src={`/api/gallery/image?path=${encodeURIComponent(image.path)}`}
                      alt=""
                      className="block w-full"
                      loading="lazy"
                    />
                  </a>
                  {canonical && (
                    <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-sm bg-glass px-2 py-0.5 text-xs text-primary backdrop-blur-glass">
                      <BadgeCheck className="size-3.5" />定稿
                      {entry?.style_stale && <span className="text-destructive">风格已变更</span>}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void onToggleCanonical(screenId, image.path)}
                    aria-label={canonical ? `取消定稿 ${image.filename}` : `设为定稿 ${image.filename}`}
                    className={cn(
                      'absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-scrim/70 backdrop-blur-glass transition-opacity hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      canonical ? 'text-primary opacity-100' : 'text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                    )}
                  >
                    <BadgeCheck className="size-3.5" />
                  </button>
                </div>
                <figcaption className="flex items-baseline gap-2 px-0.5 text-xs">
                  <span className="truncate text-foreground/85">{image.style_variant || image.filename}</span>
                  {image.base_version && <span className="shrink-0 font-mono text-muted-foreground/60">← {image.base_version}</span>}
                </figcaption>
                {(image.model || image.provider) && (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {[image.provider, image.model].filter(Boolean).join(' · ')}
                  </p>
                )}
                {image.prompt && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer text-foreground/75">查看生成提示词</summary>
                    <p className="mt-2 whitespace-pre-wrap leading-relaxed">{image.prompt}</p>
                  </details>
                )}
              </figure>
            );
          })}
        </div>
      ) : (
        <div className="grid min-h-[240px] place-items-center rounded-lg border border-border bg-card/30 text-center">
          <p className="text-sm text-muted-foreground">这个页面尚未生成版本。</p>
        </div>
      )}
    </section>
  );
}

function UiEmpty() {
  return (
    <section className="grid min-h-[320px] place-items-center rounded-lg border border-border bg-card/30 px-6 text-center">
      <div className="max-w-lg space-y-4">
        <PanelsTopLeft className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <div className="space-y-2">
          <h2 className="font-display text-display italic text-foreground/70">这个项目还没有 UI 设计锚</h2>
          <p className="text-sm text-muted-foreground">先用 UI 总控确定 GDD、PRD 与交互文档，再开始页面生成。</p>
        </div>
        <code className="inline-flex rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">/game-atelier:ui</code>
      </div>
    </section>
  );
}

function groupScreens(items: ProjectScreenItem[]): Array<[string, ProjectScreenItem[]]> {
  const order: string[] = [];
  const groups = new Map<string, ProjectScreenItem[]>();
  for (const item of items) {
    if (!groups.has(item.screen_id)) {
      groups.set(item.screen_id, []);
      order.push(item.screen_id);
    }
    groups.get(item.screen_id)!.push(item);
  }
  return order.map(id => [id, groups.get(id)!]);
}

function screenStatusLabel(status: string): string {
  return ({ planned: '待设计', generated: '待定稿', canonical: '已定稿', stale: '已过时' } as Record<string, string>)[status] ?? status;
}

function effectiveScreenStatus(
  plannedStatus: string | undefined,
  images: ProjectScreenItem[],
  canonical: ScreenCanonicalFile['screens'][string] | undefined,
): string {
  if (canonical?.style_stale) return 'stale';
  if (canonical) return 'canonical';
  if (images.length > 0) return 'generated';
  return plannedStatus ?? 'planned';
}
