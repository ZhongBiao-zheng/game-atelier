import {
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Library,
  Pencil,
  Plus,
  Search,
  SendToBack,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';

import { canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type {
  CanvasContentVersion,
  CanvasLibraryAsset,
  CanvasPrompt,
  RevisionedSidecar,
} from '@/schema/canvas';

export type CanvasLibraryMode = 'assets' | 'prompts';
export const CANVAS_LIBRARY_DRAG_TYPE = 'application/x-game-atelier-canvas-library';

type PromptDraft = { promptId?: string; title: string; content: string; tags: string };
type AssetDraft = { assetId: string; title: string; tags: string };

export function CanvasLibraryPanel({
  mode,
  projectId,
  assets,
  prompts,
  contentVersions,
  focusAssetId,
  busy,
  error,
  onModeChange,
  onClose,
  onInsertAsset,
  onInsertPrompt,
  onUpdateAsset,
  onDeleteAsset,
  onCreatePrompt,
  onUpdatePrompt,
  onDeletePrompt,
}: {
  mode: CanvasLibraryMode;
  projectId: string;
  assets: RevisionedSidecar<CanvasLibraryAsset> | null;
  prompts: RevisionedSidecar<CanvasPrompt> | null;
  contentVersions: Readonly<Record<string, CanvasContentVersion>>;
  focusAssetId: string | null;
  busy: boolean;
  error: string | null;
  onModeChange: (mode: CanvasLibraryMode) => void;
  onClose: () => void;
  onInsertAsset: (assetId: string) => void;
  onInsertPrompt: (promptId: string) => void;
  onUpdateAsset: (assetId: string, input: { title: string; tags: string[] }) => Promise<void>;
  onDeleteAsset: (assetId: string) => Promise<void>;
  onCreatePrompt: (input: { title: string; content: string; tags: string[] }) => Promise<void>;
  onUpdatePrompt: (promptId: string, input: { title: string; content: string; tags: string[] }) => Promise<void>;
  onDeletePrompt: (promptId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [promptDraft, setPromptDraft] = useState<PromptDraft | null>(null);
  const [assetDraft, setAssetDraft] = useState<AssetDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: CanvasLibraryMode; id: string; title: string } | null>(null);

  useEffect(() => {
    setQuery('');
    setPromptDraft(null);
    setAssetDraft(null);
    setDraftError(null);
  }, [mode, projectId]);

  useEffect(() => {
    if (mode !== 'assets' || !focusAssetId) return;
    requestAnimationFrame(() => {
      const card = document.getElementById(`canvas-library-${focusAssetId}`);
      card?.scrollIntoView({ block: 'nearest' });
      card?.focus({ preventScroll: true });
    });
  }, [focusAssetId, mode]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAssets = useMemo(() => (assets?.items ?? []).filter(item => (
    !normalizedQuery
    || item.title.toLocaleLowerCase().includes(normalizedQuery)
    || item.tags.some(tag => tag.toLocaleLowerCase().includes(normalizedQuery))
  )), [assets?.items, normalizedQuery]);
  const visiblePrompts = useMemo(() => (prompts?.items ?? []).filter(item => (
    !normalizedQuery
    || item.title.toLocaleLowerCase().includes(normalizedQuery)
    || item.content.toLocaleLowerCase().includes(normalizedQuery)
    || item.tags.some(tag => tag.toLocaleLowerCase().includes(normalizedQuery))
  )), [normalizedQuery, prompts?.items]);

  function startDrag(event: DragEvent, kind: 'asset' | 'prompt', id: string) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(CANVAS_LIBRARY_DRAG_TYPE, JSON.stringify({ kind, id }));
  }

  async function submitPrompt() {
    if (!promptDraft?.title.trim() || !promptDraft.content.trim()) {
      setDraftError('标题和提示词内容都不能为空。');
      return;
    }
    setDraftError(null);
    const input = {
      title: promptDraft.title.trim(),
      content: promptDraft.content.trim(),
      tags: parseTags(promptDraft.tags),
    };
    try {
      if (promptDraft.promptId) await onUpdatePrompt(promptDraft.promptId, input);
      else await onCreatePrompt(input);
      setPromptDraft(null);
    } catch {
      // 父组件在表单旁显示请求错误，并保留草稿。
    }
  }

  async function submitAsset() {
    if (!assetDraft?.title.trim()) {
      setDraftError('资产标题不能为空。');
      return;
    }
    setDraftError(null);
    try {
      await onUpdateAsset(assetDraft.assetId, {
        title: assetDraft.title.trim(),
        tags: parseTags(assetDraft.tags),
      });
      setAssetDraft(null);
    } catch {
      // 父组件在表单旁显示请求错误，并保留草稿。
    }
  }

  return (
    <>
      <aside
        id="canvas-library-panel"
        aria-label={mode === 'assets' ? '项目资产库' : '项目提示词库'}
        className="canvas-library-panel absolute bottom-3 top-20 z-20 flex w-[min(22rem,calc(100vw-5rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover shell-glow md:top-24"
      >
        <header className="flex items-center justify-between border-b border-border p-3">
          <div className="flex items-center gap-2">
            <Library className="size-4 text-primary" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">项目创作库</p>
              <p className="text-xs text-muted-foreground">拖到画布，或点击插入</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭项目创作库" onClick={onClose}><X /></Button>
        </header>

        <div className="grid grid-cols-2 border-b border-border p-1.5" role="group" aria-label="创作库类型">
          <button type="button" aria-pressed={mode === 'assets'} onClick={() => onModeChange('assets')} className={cn('rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground', mode === 'assets' && 'bg-secondary text-foreground')}>资产</button>
          <button type="button" aria-pressed={mode === 'prompts'} onClick={() => onModeChange('prompts')} className={cn('rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground', mode === 'prompts' && 'bg-secondary text-foreground')}>提示词</button>
        </div>

        <div className="p-3 pb-2">
          <label className="relative block">
            <span className="sr-only">搜索{mode === 'assets' ? '资产' : '提示词'}</span>
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder={`搜索${mode === 'assets' ? '资产' : '提示词'}或标签`} className="canvas-input pl-9" />
          </label>
          {mode === 'prompts' && !promptDraft && (
            <Button variant="outline" size="sm" className="mt-2 w-full" disabled={busy || !prompts} onClick={() => { setDraftError(null); setPromptDraft({ title: '', content: '', tags: '' }); }}><Plus />新建提示词</Button>
          )}
        </div>

        {error && <p role="alert" className="mx-3 mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

        {mode === 'assets' && assetDraft && (
          <LibraryForm title="编辑资产" busy={busy} error={draftError} onCancel={() => setAssetDraft(null)} onSubmit={() => void submitAsset()}>
            <input required aria-invalid={Boolean(draftError && !assetDraft.title.trim())} aria-label="资产标题" value={assetDraft.title} onChange={event => { setDraftError(null); setAssetDraft({ ...assetDraft, title: event.target.value }); }} className="canvas-input" />
            <input aria-label="资产标签" value={assetDraft.tags} onChange={event => setAssetDraft({ ...assetDraft, tags: event.target.value })} placeholder="标签，以逗号分隔" className="canvas-input" />
          </LibraryForm>
        )}

        {mode === 'prompts' && promptDraft && (
          <LibraryForm title={promptDraft.promptId ? '编辑提示词' : '新建提示词'} busy={busy} error={draftError} onCancel={() => setPromptDraft(null)} onSubmit={() => void submitPrompt()}>
            <input required aria-invalid={Boolean(draftError && !promptDraft.title.trim())} aria-label="提示词标题" value={promptDraft.title} onChange={event => { setDraftError(null); setPromptDraft({ ...promptDraft, title: event.target.value }); }} placeholder="标题" className="canvas-input" />
            <textarea required aria-invalid={Boolean(draftError && !promptDraft.content.trim())} aria-label="提示词内容" rows={6} value={promptDraft.content} onChange={event => { setDraftError(null); setPromptDraft({ ...promptDraft, content: event.target.value }); }} placeholder="写下可复用的提示词…" className="canvas-input resize-y" />
            <input aria-label="提示词标签" value={promptDraft.tags} onChange={event => setPromptDraft({ ...promptDraft, tags: event.target.value })} placeholder="标签，以逗号分隔" className="canvas-input" />
          </LibraryForm>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {mode === 'assets' ? (
            visibleAssets.length ? visibleAssets.map(asset => {
              const version = contentVersions[asset.version_id];
              return (
                <article id={`canvas-library-${asset.asset_id}`} key={asset.asset_id} tabIndex={-1} draggable onDragStart={event => startDrag(event, 'asset', asset.asset_id)} className="group mb-2 rounded-lg border border-border bg-card p-2 outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  <div className="flex gap-2">
                    <LibraryAssetPreview projectId={projectId} version={version} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{asset.title}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{asset.tags.length ? asset.tags.join(' · ') : version?.kind ?? '内容版本'}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex justify-end gap-1">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraftError(null); setAssetDraft({ assetId: asset.asset_id, title: asset.title, tags: asset.tags.join(', ') }); }}><Pencil />编辑</Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingDelete({ kind: 'assets', id: asset.asset_id, title: asset.title })}><Trash2 />移出</Button>
                    <Button size="sm" disabled={busy || !version} onClick={() => onInsertAsset(asset.asset_id)}><SendToBack />插入</Button>
                  </div>
                </article>
              );
            }) : <LibraryEmpty text={normalizedQuery ? '没有匹配的项目资产' : '还没有资产。选中有内容的节点后，点击“存入资产库”。'} />
          ) : (
            visiblePrompts.length ? visiblePrompts.map(prompt => (
              <article key={prompt.prompt_id} draggable onDragStart={event => startDrag(event, 'prompt', prompt.prompt_id)} className="group mb-2 rounded-lg border border-border bg-card p-3">
                <p className="truncate text-sm font-medium">{prompt.title}</p>
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{prompt.content}</p>
                {prompt.tags.length > 0 && <p className="mt-2 truncate text-xs text-muted-foreground">{prompt.tags.join(' · ')}</p>}
                <div className="mt-2 flex justify-end gap-1">
                  {prompt.source === 'local' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDraftError(null); setPromptDraft({ promptId: prompt.prompt_id, title: prompt.title, content: prompt.content, tags: prompt.tags.join(', ') }); }}><Pencil />编辑</Button>}
                  {prompt.source === 'local' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingDelete({ kind: 'prompts', id: prompt.prompt_id, title: prompt.title })}><Trash2 />删除</Button>}
                  <Button size="sm" disabled={busy} onClick={() => onInsertPrompt(prompt.prompt_id)}><SendToBack />插入</Button>
                </div>
              </article>
            )) : <LibraryEmpty text={normalizedQuery ? '没有匹配的提示词' : '还没有提示词。创建后可拖入画布成为文本节点。'} />
          )}
        </div>
      </aside>

      <Dialog open={Boolean(pendingDelete)} onOpenChange={open => { if (!open) setPendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingDelete?.kind === 'assets' ? '移出资产库？' : '删除提示词？'}</DialogTitle>
            <DialogDescription>
              {pendingDelete?.kind === 'assets'
                ? `“${pendingDelete.title}”只会从资产库移出，画布节点和原内容不会被删除。`
                : `“${pendingDelete?.title}”将从当前项目永久删除。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>取消</Button>
            <Button variant="destructive" disabled={busy} onClick={() => {
              if (!pendingDelete) return;
              const action = pendingDelete.kind === 'assets'
                ? onDeleteAsset(pendingDelete.id)
                : onDeletePrompt(pendingDelete.id);
              void action.then(() => setPendingDelete(null)).catch(() => undefined);
            }}>{busy ? '处理中…' : '确认'}</Button>
          </DialogFooter>
          {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}

function LibraryForm({ title, busy, error, onCancel, onSubmit, children }: {
  title: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form noValidate className="mx-3 mb-3 space-y-2 rounded-lg border border-border bg-card p-3" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
      <p className="text-sm font-medium">{title}</p>
      {children}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
      </div>
    </form>
  );
}

function LibraryAssetPreview({ projectId, version }: { projectId: string; version?: CanvasContentVersion }) {
  const className = 'grid size-14 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-secondary text-muted-foreground';
  if (!version) return <span className={className}><FileText className="size-5" aria-hidden="true" /></span>;
  if (version.kind === 'image') return <span className={className}><img src={canvasMediaUrl(projectId, version.version_id)} alt="" loading="lazy" className="size-full object-cover" /></span>;
  if (version.kind === 'video') return <span className={className}><FileVideo className="size-5" aria-hidden="true" /></span>;
  if (version.kind === 'audio') return <span className={className}><FileAudio className="size-5" aria-hidden="true" /></span>;
  if (version.kind === 'text') return <span className={className}><FileText className="size-5" aria-hidden="true" /></span>;
  return <span className={className}><FileImage className="size-5" aria-hidden="true" /></span>;
}

function LibraryEmpty({ text }: { text: string }) {
  return <div className="grid min-h-36 place-items-center rounded-lg border border-dashed border-border px-6 text-center text-xs leading-relaxed text-muted-foreground">{text}</div>;
}

function parseTags(value: string): string[] {
  return value.split(/[，,]/).map(tag => tag.trim()).filter(Boolean);
}
