import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, MoreHorizontal, Palette, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';

import {
  canvasMediaUrl,
  commitCanvasPackage,
  createCanvasProject,
  deleteCanvasProject,
  exportCanvasProjects,
  getCanvasDocument,
  inspectCanvasPackage,
  listCanvasProjects,
  listCanvasTrash,
  renameCanvasProject,
  restoreCanvasProject,
} from '@/api/canvas';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CanvasPackageInspection, CanvasProjectSummary, CanvasTrashEntry } from '@/schema/canvas';


type EditorState =
  | { open: false }
  | { open: true; name: string };

type DeleteState =
  | { open: false }
  | { open: true; project: CanvasProjectSummary; revision: number; confirmName: string };

type ImportState =
  | { open: false }
  | { open: true; filename: string; inspection: CanvasPackageInspection };


export function CanvasProjectIndex({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteState, setDeleteState] = useState<DeleteState>({ open: false });
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({ open: false });
  const [importError, setImportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [recoverable, setRecoverable] = useState<CanvasTrashEntry | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashEntries, setTrashEntries] = useState<CanvasTrashEntry[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProjects(await listCanvasProjects());
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submitEditor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor.open) return;
    const name = editor.name.trim();
    if (!name) {
      setEditorError('请输入画布项目名称');
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      const project = await createCanvasProject(name);
      setEditor({ open: false });
      onOpenProject(project.project_id);
    } catch (error) {
      setEditorError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function renameProjectInline(project: CanvasProjectSummary, name: string) {
    const renamed = await renameCanvasProject(project.project_id, name);
    setProjects(current => current
      .map(item => item.project_id === project.project_id ? { ...item, ...renamed } : item)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)));
  }

  async function prepareDelete(project: CanvasProjectSummary) {
    setBusyProjectId(project.project_id);
    setActionError(null);
    try {
      const document = await getCanvasDocument(project.project_id);
      setDeleteError(null);
      setDeleteState({ open: true, project, revision: document.revision, confirmName: '' });
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusyProjectId(null);
    }
  }

  async function submitDelete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteState.open) return;
    if (deleteState.confirmName !== deleteState.project.name) {
      setDeleteError('请输入完整项目名称以确认删除');
      return;
    }
    setBusyProjectId(deleteState.project.project_id);
    setDeleteError(null);
    try {
      const entry = await deleteCanvasProject(
        deleteState.project.project_id,
        deleteState.revision,
        deleteState.confirmName,
      );
      setProjects(current => current.filter(item => item.project_id !== entry.original_project_id));
      setRecoverable(entry);
      setDeleteState({ open: false });
    } catch (error) {
      setDeleteError((error as Error).message);
    } finally {
      setBusyProjectId(null);
    }
  }

  async function handleExport(project: CanvasProjectSummary) {
    setBusyProjectId(project.project_id);
    setActionError(null);
    try {
      await exportCanvasProjects([project.project_id]);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusyProjectId(null);
    }
  }

  async function handlePackage(file: File) {
    setImporting(true);
    setActionError(null);
    try {
      const inspection = await inspectCanvasPackage(file);
      setImportError(null);
      setImportState({ open: true, filename: file.name, inspection });
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function commitImport() {
    if (!importState.open) return;
    setImporting(true);
    setImportError(null);
    try {
      await commitCanvasPackage(importState.inspection.token);
      setImportState({ open: false });
      await load();
    } catch (error) {
      setImportError((error as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function undoDelete() {
    if (!recoverable) return;
    setImporting(true);
    setActionError(null);
    try {
      await restoreCanvasProject(recoverable.trash_id);
      setTrashEntries(current => current.filter(item => item.trash_id !== recoverable.trash_id));
      setRecoverable(null);
      await load();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function openTrash() {
    setTrashOpen(true);
    setTrashLoading(true);
    setTrashError(null);
    try {
      setTrashEntries(await listCanvasTrash());
    } catch (error) {
      setTrashError((error as Error).message);
    } finally {
      setTrashLoading(false);
    }
  }

  async function restoreTrashEntry(entry: CanvasTrashEntry) {
    setTrashLoading(true);
    setTrashError(null);
    try {
      await restoreCanvasProject(entry.trash_id);
      setTrashEntries(current => current.filter(item => item.trash_id !== entry.trash_id));
      if (recoverable?.trash_id === entry.trash_id) setRecoverable(null);
      await load();
    } catch (error) {
      setTrashError((error as Error).message);
    } finally {
      setTrashLoading(false);
    }
  }

  return (
    <section className="stable-scroll h-full overflow-y-auto bg-background">
      <div className="w-full px-4 py-8 sm:px-6 md:px-10 md:py-12">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-label text-muted-foreground">人工创作空间</p>
            <h1 className="text-balance font-display text-display italic text-foreground">画布项目</h1>
            <p className="max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground">
              从空白空间开始，手动放置文本、素材与生成节点。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={trashLoading} onClick={() => void openTrash()}>
              <Trash2 aria-hidden="true" />回收区
            </Button>
            <Button variant="outline" disabled={importing} onClick={() => importRef.current?.click()}>
              <Upload aria-hidden="true" />{importing ? '校验中…' : '导入项目包'}
            </Button>
          </div>
          <input
            ref={importRef}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            aria-label="选择 Canvas 项目包"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void handlePackage(file);
              event.target.value = '';
            }}
          />
        </header>

        {(loadError || actionError) && (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>{actionError ?? loadError}</span>
            {loadError && (
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw aria-hidden="true" />重试
              </Button>
            )}
          </div>
        )}

        {recoverable && (
          <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-3 text-sm text-foreground">
            <span>“{recoverable.project_name}”已移入回收区，将保留 30 天。</span>
            <Button variant="outline" size="sm" disabled={importing} onClick={() => void undoDelete()}>
              撤销删除
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy={loading}>
          {loading && <span role="status" className="sr-only">正在加载画布项目</span>}
          <button
            type="button"
            aria-label="新建项目"
            onClick={() => {
              setEditor({ open: true, name: '' });
              setEditorError(null);
            }}
            className="group flex min-h-72 cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card/30 px-6 text-center transition-colors hover:border-input hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors group-hover:text-foreground">
              <Plus className="size-5" aria-hidden="true" />
            </span>
            <span className="text-base font-medium text-foreground">新建项目</span>
          </button>

          {loading && projects.length === 0
            ? Array.from({ length: 3 }, (_, index) => <CanvasCardSkeleton key={index} />)
            : projects.map(project => (
              <CanvasProjectCard
                key={project.project_id}
                project={project}
                onOpen={() => onOpenProject(project.project_id)}
                onInlineRename={name => renameProjectInline(project, name)}
                onExport={() => void handleExport(project)}
                onDelete={() => void prepareDelete(project)}
                disabled={busyProjectId === project.project_id}
              />
            ))}
        </div>
      </div>

      <Dialog open={editor.open} onOpenChange={open => { if (!open && !saving) setEditor({ open: false }); }}>
        {editor.open && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建画布项目</DialogTitle>
              <DialogDescription>画布项目独立于创作台和工坊，不会由 Skill 自动填充。</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={submitEditor}>
              <div className="space-y-2">
                <Label htmlFor="canvas-project-name">画布项目名称</Label>
                <Input
                  id="canvas-project-name"
                  autoFocus
                  value={editor.name}
                  aria-invalid={Boolean(editorError)}
                  aria-describedby={editorError ? 'canvas-project-name-error' : undefined}
                  onChange={event => {
                    const name = event.target.value;
                    setEditor(current => current.open ? { ...current, name } : current);
                  }}
                />
                {editorError && <p id="canvas-project-name-error" role="alert" className="text-xs text-destructive">{editorError}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={saving} onClick={() => setEditor({ open: false })}>取消</Button>
                <Button type="submit" disabled={saving}>
                  {saving ? '保存中…' : '创建并进入'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={importState.open} onOpenChange={open => { if (!open && !importing) { setImportError(null); setImportState({ open: false }); } }}>
        {importState.open && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>导入 Canvas 项目包</DialogTitle>
              <DialogDescription>
                已通过结构、路径、配额和摘要校验。导入会创建新的项目 ID，不覆盖现有项目。
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-border bg-secondary/20 p-4 text-sm">
              <p className="truncate font-medium text-foreground">{importState.filename}</p>
              <p className="mt-1 text-muted-foreground">
                {importState.inspection.projects.map(project => project.name).join('、')} · {formatBytes(importState.inspection.extracted_bytes)} · {importState.inspection.entry_count} 个条目
              </p>
            </div>
            {importError && <p role="alert" className="text-xs text-destructive">{importError}</p>}
            <DialogFooter>
              <Button variant="outline" disabled={importing} onClick={() => setImportState({ open: false })}>取消</Button>
              <Button disabled={importing} onClick={() => void commitImport()}>
                {importing ? '导入中…' : `导入 ${importState.inspection.projects.length} 个项目`}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={deleteState.open} onOpenChange={open => { if (!open && !busyProjectId) setDeleteState({ open: false }); }}>
        {deleteState.open && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>删除“{deleteState.project.name}”？</DialogTitle>
              <DialogDescription>
                项目和生成记录会移入回收区并保留 30 天。请输入完整项目名称确认。
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={submitDelete}>
              <div className="space-y-2">
                <Label htmlFor="canvas-delete-confirm">项目名称</Label>
                <Input
                  id="canvas-delete-confirm"
                  autoFocus
                  autoComplete="off"
                  aria-invalid={Boolean(deleteError)}
                  aria-describedby={deleteError ? 'canvas-delete-confirm-error' : undefined}
                  value={deleteState.confirmName}
                  onChange={event => {
                    setDeleteError(null);
                    setDeleteState(current => current.open ? {
                      ...current,
                      confirmName: event.target.value,
                    } : current);
                  }}
                />
                {deleteError && <p id="canvas-delete-confirm-error" role="alert" className="text-xs text-destructive">{deleteError}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={Boolean(busyProjectId)} onClick={() => setDeleteState({ open: false })}>取消</Button>
                <Button type="submit" variant="destructive" disabled={Boolean(busyProjectId)}>
                  {busyProjectId ? '正在移入回收区…' : '删除项目'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={trashOpen} onOpenChange={open => { if (!trashLoading) { setTrashError(null); setTrashOpen(open); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>画布回收区</DialogTitle>
            <DialogDescription>删除的项目保留 30 天；恢复时会分配新的项目 ID。</DialogDescription>
          </DialogHeader>
          {trashError && <p role="alert" className="text-xs text-destructive">{trashError}</p>}
          <div className="max-h-80 space-y-2 overflow-y-auto" aria-busy={trashLoading}>
            {trashLoading && trashEntries.length === 0 && (
              <p role="status" className="py-8 text-center text-sm text-muted-foreground">正在读取回收区…</p>
            )}
            {!trashLoading && trashEntries.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">回收区是空的</p>
            )}
            {trashEntries.map(entry => (
              <div key={entry.trash_id} className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/20 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{entry.project_name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatExpiry(entry.expires_at)}</p>
                </div>
                <Button variant="outline" size="sm" disabled={trashLoading} onClick={() => void restoreTrashEntry(entry)}>
                  恢复
                </Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={trashLoading} onClick={() => setTrashOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}


function CanvasProjectCard({
  project,
  onOpen,
  onInlineRename,
  onExport,
  onDelete,
  disabled,
}: {
  project: CanvasProjectSummary;
  onOpen: () => void;
  onInlineRename: (name: string) => Promise<void>;
  onExport: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(project.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const renameInFlight = useRef(false);
  const cancelRename = useRef(false);

  function beginInlineRename() {
    if (disabled) return;
    cancelRename.current = false;
    setRenameDraft(project.name);
    setRenameError(null);
    setRenaming(true);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }

  async function commitInlineRename(restoreFocus: boolean) {
    if (renameInFlight.current || cancelRename.current) return;
    const name = renameDraft.trim();
    if (!name) {
      setRenameError('请输入画布项目名称');
      requestAnimationFrame(() => renameInputRef.current?.focus());
      return;
    }
    if (name === project.name) {
      setRenaming(false);
      if (restoreFocus) requestAnimationFrame(() => renameTriggerRef.current?.focus());
      return;
    }
    renameInFlight.current = true;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await onInlineRename(name);
      setRenaming(false);
      if (restoreFocus) requestAnimationFrame(() => renameTriggerRef.current?.focus());
    } catch (error) {
      setRenameError((error as Error).message);
      requestAnimationFrame(() => renameInputRef.current?.focus());
    } finally {
      renameInFlight.current = false;
      setRenameBusy(false);
    }
  }

  return (
    <article className="group relative overflow-hidden rounded-xl border border-border bg-card/45 transition-colors hover:border-input">
      <button
        type="button"
        disabled={disabled}
        aria-label={`打开画布项目 ${project.name}`}
        onClick={onOpen}
        className="block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        {project.cover ? (
          <img
            src={canvasMediaUrl(project.project_id, project.cover.version_id)}
            alt=""
            loading="lazy"
            className="aspect-[16/10] w-full border-b border-border object-cover"
          />
        ) : (
          <div className="grid aspect-[16/10] place-items-center border-b border-border bg-secondary/30 text-muted-foreground">
            <Palette className="size-8" aria-hidden="true" />
          </div>
        )}
      </button>
      <div className="min-h-28 space-y-1 p-4 pr-14">
        {renaming ? (
          <div className="space-y-1.5">
            <Input
              ref={renameInputRef}
              value={renameDraft}
              disabled={renameBusy}
              aria-label={`重命名画布项目 ${project.name}`}
              aria-invalid={Boolean(renameError)}
              onChange={event => setRenameDraft(event.target.value)}
              onBlur={() => void commitInlineRename(false)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void commitInlineRename(true);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename.current = true;
                  setRenameError(null);
                  setRenaming(false);
                  requestAnimationFrame(() => renameTriggerRef.current?.focus());
                }
              }}
            />
            {renameError && <p role="alert" className="text-xs text-destructive">{renameError}</p>}
          </div>
        ) : (
          <button
            ref={renameTriggerRef}
            type="button"
            disabled={disabled}
            title="双击重命名"
            onClick={event => {
              if (event.detail === 0) onOpen();
            }}
            onDoubleClick={event => {
              event.preventDefault();
              beginInlineRename();
            }}
            className="block max-w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <h2 className="truncate text-base font-medium text-foreground">{project.name}</h2>
          </button>
        )}
        <p className="text-xs text-muted-foreground">
          <span className="tabular-nums">{project.node_count}</span> 个节点 · <span className="tabular-nums">{project.connection_count}</span> 条连线
        </p>
        <p className="tabular-nums text-sm text-muted-foreground">{formatActivity(project.updated_at)}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={disabled || renameBusy} variant="ghost" size="icon" aria-label={`管理画布项目 ${project.name}`} className="absolute bottom-2 right-2 size-11">
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => window.setTimeout(beginInlineRename, 0)}><Pencil aria-hidden="true" />重命名</DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport}><Download aria-hidden="true" />导出项目包</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDelete} className="text-destructive"><Trash2 aria-hidden="true" />删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  );
}


function CanvasCardSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-border bg-card/30">
      <div className="aspect-[16/10] animate-pulse border-b border-border bg-secondary/40 motion-reduce:animate-none" />
      <div className="min-h-24 space-y-2 p-4">
        <div className="h-4 w-2/3 animate-pulse rounded-sm bg-secondary motion-reduce:animate-none" />
        <div className="h-3 w-1/3 animate-pulse rounded-sm bg-secondary/70 motion-reduce:animate-none" />
      </div>
    </div>
  );
}


function formatActivity(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚编辑';
  return `编辑于 ${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)}`;
}


function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}


function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '恢复期限未知';
  return `保留至 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)}`;
}
