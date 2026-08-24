import { useCallback, useEffect, useState } from 'react';
import { MoreHorizontal, Palette, Pencil, Plus, RefreshCw } from 'lucide-react';

import {
  canvasMediaUrl,
  createCanvasProject,
  listCanvasProjects,
  renameCanvasProject,
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CanvasProjectSummary } from '@/schema/canvas';


type EditorState =
  | { open: false }
  | { open: true; mode: 'create'; name: string }
  | { open: true; mode: 'rename'; project: CanvasProjectSummary; name: string };


export function CanvasProjectIndex({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      if (editor.mode === 'create') {
        const project = await createCanvasProject(name);
        setEditor({ open: false });
        onOpenProject(project.project_id);
        return;
      }
      await renameCanvasProject(editor.project.project_id, name);
      setEditor({ open: false });
      await load();
    } catch (error) {
      setEditorError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="stable-scroll h-full overflow-y-auto bg-background">
      <div className="w-full px-4 py-8 sm:px-6 md:px-10 md:py-12">
        <header className="mb-8 space-y-2">
          <p className="text-xs uppercase tracking-label text-muted-foreground">人工创作空间</p>
          <h1 className="text-balance font-display text-display italic text-foreground">画布项目</h1>
          <p className="max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground">
            从空白空间开始，手动放置文本、素材与生成节点。
          </p>
        </header>

        {loadError && (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />重试
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy={loading}>
          {loading && <span role="status" className="sr-only">正在加载画布项目</span>}
          <button
            type="button"
            aria-label="新建项目"
            onClick={() => {
              setEditor({ open: true, mode: 'create', name: '' });
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
                onRename={() => {
                  setEditor({ open: true, mode: 'rename', project, name: project.name });
                  setEditorError(null);
                }}
              />
            ))}
        </div>
      </div>

      <Dialog open={editor.open} onOpenChange={open => { if (!open && !saving) setEditor({ open: false }); }}>
        {editor.open && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editor.mode === 'create' ? '新建画布项目' : '重命名画布项目'}</DialogTitle>
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
                  {saving ? '保存中…' : editor.mode === 'create' ? '创建并进入' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}


function CanvasProjectCard({
  project,
  onOpen,
  onRename,
}: {
  project: CanvasProjectSummary;
  onOpen: () => void;
  onRename: () => void;
}) {
  return (
    <article className="group relative overflow-hidden rounded-xl border border-border bg-card/45 transition-colors hover:border-input">
      <button
        type="button"
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
        <div className="min-h-24 space-y-1 p-4 pr-14">
          <h2 className="truncate text-base font-medium text-foreground">{project.name}</h2>
          <p className="tabular-nums text-sm text-muted-foreground">{formatActivity(project.updated_at)}</p>
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`管理画布项目 ${project.name}`} className="absolute bottom-2 right-2 size-11">
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}><Pencil aria-hidden="true" />重命名</DropdownMenuItem>
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
