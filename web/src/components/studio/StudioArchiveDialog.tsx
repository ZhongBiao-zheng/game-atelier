import { useEffect, useMemo, useState } from 'react';
import { Check, FolderInput } from 'lucide-react';

import {
  archiveStudioOutput,
  fetchStudioArchiveTargets,
  studioArchiveTarget,
  type StudioArchiveTargetOption,
} from '@/api/studio';
import { fetchProjects } from '@/api/projects';
import type { JobKind, Project } from '@/schema/jobs';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';


export interface StudioArchiveRequest {
  jobId: string;
  path: string;
  mediaKind: JobKind;
}

const selectClass = 'min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50';

function targetKey(target: StudioArchiveTargetOption): string {
  if (target.kind === 'character') return `character:${target.character_id}:${target.asset_slot}`;
  if (target.kind === 'ui') return `ui:${target.ui_scheme_id}:${target.screen_id}`;
  return `video:${target.production_id}`;
}

const kindLabels: Record<StudioArchiveTargetOption['kind'], string> = {
  character: '角色资产',
  ui: 'UI 页面',
  video: '视频企划',
};

export function StudioArchiveDialog({
  request,
  onClose,
}: {
  request: StudioArchiveRequest | null;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [targets, setTargets] = useState<StudioArchiveTargetOption[]>([]);
  const [targetKind, setTargetKind] = useState<StudioArchiveTargetOption['kind']>('character');
  const [selectedKey, setSelectedKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ label: string; path: string } | null>(null);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setProjects([]);
    setProjectId('');
    setTargets([]);
    setSelectedKey('');
    setTargetKind(request.mediaKind === 'video' ? 'video' : 'character');
    setError(null);
    setSuccess(null);
    setLoading(true);
    fetchProjects()
      .then(file => {
        if (cancelled) return;
        setProjects(file.projects);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError('项目读取失败，请稍后重试。');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [request]);

  useEffect(() => {
    if (!request || !projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTargets([]);
    setSelectedKey('');
    fetchStudioArchiveTargets(projectId, request.mediaKind)
      .then(items => {
        if (cancelled) return;
        setTargets(items);
        const preferred = request.mediaKind === 'video'
          ? items.find(item => item.kind === 'video')
          : items.find(item => item.kind === targetKind) ?? items[0];
        if (preferred) {
          setTargetKind(preferred.kind);
        }
      })
      .catch(() => {
        if (!cancelled) setError('归档位置读取失败，请稍后重试。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, request]);

  const availableKinds = useMemo(
    () => Array.from(new Set(targets.map(target => target.kind))),
    [targets],
  );
  const visibleTargets = useMemo(
    () => targets.filter(target => target.kind === targetKind),
    [targetKind, targets],
  );
  const selected = targets.find(target => targetKey(target) === selectedKey) ?? null;

  function changeKind(kind: StudioArchiveTargetOption['kind']) {
    setTargetKind(kind);
    setSelectedKey('');
  }

  async function submit() {
    if (!request || !projectId || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await archiveStudioOutput(request.jobId, {
        source_path: request.path,
        project_id: projectId,
        target: studioArchiveTarget(selected),
      });
      setSuccess({ label: selected.label, path: result.path });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '归档失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={open => { if (!open && !submitting) onClose(); }}>
      <DialogContent>
        {success ? (
          <div className="space-y-5 py-2 text-center">
            <span className="mx-auto grid size-11 place-items-center rounded-full border border-border bg-secondary text-[color:var(--status-done)]">
              <Check className="size-5" aria-hidden />
            </span>
            <DialogHeader className="pr-0">
              <DialogTitle>已归档到项目资产</DialogTitle>
              <DialogDescription>{success.label}</DialogDescription>
            </DialogHeader>
            <p className="break-words font-mono text-xs text-muted-foreground">{success.path}</p>
            <Button type="button" className="min-h-11 w-full" onClick={onClose}>完成</Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FolderInput className="size-4" aria-hidden />
                归档到项目资产
              </DialogTitle>
              <DialogDescription>
                Studio 原文件会保留，并在所选位置创建一个新的正式版本。
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="archive-project">项目</Label>
                <select
                  id="archive-project"
                  value={projectId}
                  onChange={event => setProjectId(event.target.value)}
                  disabled={loading || projects.length === 0}
                  className={selectClass}
                >
                  {projects.length > 0 && <option value="">选择项目…</option>}
                  {projects.length === 0 && <option value="">没有可用项目</option>}
                  {projects.map(project => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </div>

              {request?.mediaKind === 'image' && availableKinds.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="archive-kind">资产类型</Label>
                  <select
                    id="archive-kind"
                    value={targetKind}
                    onChange={event => changeKind(event.target.value as StudioArchiveTargetOption['kind'])}
                    disabled={loading}
                    className={selectClass}
                  >
                    {availableKinds.map(kind => (
                      <option key={kind} value={kind}>{kindLabels[kind]}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="archive-target">归档位置</Label>
                <select
                  id="archive-target"
                  value={selectedKey}
                  onChange={event => setSelectedKey(event.target.value)}
                  disabled={loading || visibleTargets.length === 0}
                  className={selectClass}
                >
                  {loading && <option value="">正在读取…</option>}
                  {!loading && visibleTargets.length > 0 && <option value="">选择归档位置…</option>}
                  {!loading && visibleTargets.length === 0 && <option value="">没有可用位置</option>}
                  {visibleTargets.map(target => (
                    <option key={targetKey(target)} value={targetKey(target)}>
                      {target.label}
                    </option>
                  ))}
                </select>
                {selected && <p className="text-xs text-muted-foreground">{selected.detail}</p>}
              </div>

              {!loading && projects.length === 0 && (
                <p role="status" className="text-sm text-muted-foreground">请先在工坊新建一个项目。</p>
              )}
              {!loading && projects.length > 0 && targets.length === 0 && !error && (
                <p role="status" className="text-sm text-muted-foreground">
                  当前项目还没有适合这个产物的正式资产目标，请先在工坊建立对象。
                </p>
              )}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" className="min-h-11" disabled={submitting} onClick={onClose}>
                取消
              </Button>
              <Button
                type="button"
                className="min-h-11"
                disabled={loading || submitting || !selected}
                onClick={() => void submit()}
              >
                {submitting ? '归档中…' : '确认归档'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
