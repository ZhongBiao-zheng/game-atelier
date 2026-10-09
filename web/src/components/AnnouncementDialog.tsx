import { useEffect, useState } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';

import { listKeys, patchKey, previewModels, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { SwapLabel } from '@/components/ui/swap-label';
import {
  ANNOUNCEMENTS,
  KEYS_CHANGED_EVENT,
  OPEN_ANNOUNCEMENT_EVENT,
  findCandidates,
  latestUnseenAnnouncement,
  markAnnouncementsSeen,
  withAddedModels,
  type Announcement,
  type ModelCandidate,
} from '@/lib/announcements';
import { providerLabel } from '@/lib/providerLabels';

type KeyScan =
  | { key: KeyView; status: 'ok'; candidates: ModelCandidate[] }
  | { key: KeyView; status: 'error'; message: string };

type Step =
  | { kind: 'intro' }
  | { kind: 'scanning' }
  | { kind: 'confirm'; scans: KeyScan[] }
  | { kind: 'done'; count: number };

const selectionKey = (alias: string, modelId: string) => `${alias}\u0000${modelId}`;

/** 没开通的供应商不列出；拉取失败的保留，否则分不清「没开通」和「查不了」。 */
const visibleScans = (scans: KeyScan[]) => scans.filter(item => item.status === 'error' || item.candidates.length > 0);

/** 启动时弹出最新一条未读公告；关掉即记为已读。更新日志里的公告卡片按 id 通过事件再次打开。 */
export function AnnouncementHost() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(() => latestUnseenAnnouncement());

  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string | undefined>).detail;
      setAnnouncement(ANNOUNCEMENTS.find(item => item.id === id) ?? ANNOUNCEMENTS[0] ?? null);
    };
    window.addEventListener(OPEN_ANNOUNCEMENT_EVENT, open);
    return () => window.removeEventListener(OPEN_ANNOUNCEMENT_EVENT, open);
  }, []);

  if (!announcement) return null;
  return (
    <AnnouncementDialog
      key={announcement.id}
      announcement={announcement}
      onClose={() => {
        markAnnouncementsSeen();
        setAnnouncement(null);
      }}
    />
  );
}

export function AnnouncementDialog({ announcement, onClose }: { announcement: Announcement; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  async function scan() {
    setStep({ kind: 'scanning' });
    setError(null);
    try {
      const { keys } = await listKeys();
      const scans = await Promise.all(keys.map(async (key): Promise<KeyScan> => {
        try {
          const { models } = await previewModels({ alias: key.alias });
          return { key, status: 'ok', candidates: findCandidates(models, announcement.models, key.models) };
        } catch (scanError) {
          return { key, status: 'error', message: (scanError as Error).message };
        }
      }));
      setSelected(new Set(scans.flatMap(item => item.status === 'ok'
        ? item.candidates
          .filter(candidate => candidate.kind === 'exact' && !candidate.added)
          .map(candidate => selectionKey(item.key.alias, candidate.model.id))
        : [])));
      setStep({ kind: 'confirm', scans });
    } catch (scanError) {
      setError((scanError as Error).message);
      setStep({ kind: 'intro' });
    }
  }

  async function save(scans: KeyScan[]) {
    setSaving(true);
    setError(null);
    let count = 0;
    try {
      for (const item of scans) {
        if (item.status !== 'ok') continue;
        const picked = item.candidates
          .filter(candidate => !candidate.added && selected.has(selectionKey(item.key.alias, candidate.model.id)))
          .map(candidate => candidate.model);
        if (!picked.length) continue;
        await patchKey(item.key.alias, { models: withAddedModels(item.key, picked) });
        count += picked.length;
      }
      window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
      setStep({ kind: 'done', count });
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent hideClose className="max-w-md gap-0 overflow-hidden p-0">
        <DialogClose
          aria-label="关闭"
          className="absolute right-5 top-5 z-10 grid size-8 place-items-center rounded-full bg-scrim text-white backdrop-blur-glass transition-colors hover:bg-scrim/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X className="size-4" aria-hidden="true" />
        </DialogClose>

        {(step.kind === 'intro' || step.kind === 'scanning') && (
          <>
            {/* 同心圆角：图片内缩 10px，圆角 = 外框 20px − 10px */}
            {!imageFailed && (
              <div className="p-2.5 pb-0">
                <img
                  src={announcement.imageUrl}
                  alt=""
                  className="aspect-video w-full rounded-md bg-secondary object-cover"
                  onError={() => setImageFailed(true)}
                />
              </div>
            )}
            <div className="space-y-3 p-5">
              <DialogTitle className="leading-snug">{announcement.title}</DialogTitle>
              <DialogDescription>{announcement.summary}</DialogDescription>
              <ul className="flex flex-wrap gap-1.5">
                {announcement.models.map(model => (
                  <li key={model.name} className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {model.name}
                  </li>
                ))}
              </ul>
              {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
              <div className="flex justify-end pt-1">
                <Button size="sm" disabled={step.kind === 'scanning'} onClick={() => void scan()}>
                  {step.kind === 'scanning' ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                  <SwapLabel active={step.kind === 'scanning'} on="查找中…" off="快速添加" />
                </Button>
              </div>
            </div>
          </>
        )}

        {step.kind === 'confirm' && (
          <div className="space-y-4 p-5">
            <DialogTitle>添加到供应商</DialogTitle>
            <DialogDescription className="sr-only">勾选要加入各供应商模型列表的模型</DialogDescription>
            <div className="max-h-80 space-y-4 overflow-y-auto">
              {!visibleScans(step.scans).length && <p className="text-sm text-muted-foreground">暂无供应商开通</p>}
              {visibleScans(step.scans).map(item => (
                <section key={item.key.alias} className="space-y-1.5">
                  <h3 className="text-xs text-muted-foreground">
                    {item.key.alias} · {providerLabel(item.key.provider, item.key.alias)}
                  </h3>
                  {item.status === 'error' && <p className="text-xs text-destructive" title={item.message}>拉取模型列表失败</p>}
                  {item.status === 'ok' && item.candidates.map(candidate => {
                    const key = selectionKey(item.key.alias, candidate.model.id);
                    return (
                      <label key={candidate.model.id} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-secondary/40">
                        <input
                          type="checkbox"
                          className="accent-primary"
                          disabled={candidate.added}
                          checked={candidate.added || selected.has(key)}
                          onChange={() => toggle(key)}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{candidate.model.id}</span>
                      </label>
                    );
                  })}
                </section>
              ))}
            </div>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setStep({ kind: 'intro' })}>返回</Button>
              <Button size="sm" disabled={saving || selected.size === 0} onClick={() => void save(step.scans)}>
                <SwapLabel active={saving} on="添加中…" off={`添加 ${selected.size} 个`} />
              </Button>
            </DialogFooter>
          </div>
        )}

        {step.kind === 'done' && (
          <div className="space-y-4 p-5">
            <DialogTitle>{step.count ? `已添加 ${step.count} 个模型` : '没有需要添加的模型'}</DialogTitle>
            <DialogDescription className="sr-only">添加结果</DialogDescription>
            <DialogFooter>
              <Button size="sm" onClick={onClose}>完成</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
