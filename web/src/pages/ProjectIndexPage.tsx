import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { fetchProjectIndex, type ProjectIndexItem } from '@/api/gallery';
import { createProject, deleteProject, renameProject } from '@/api/projects';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type EditorState =
  | { open: false }
  | { open: true; mode: 'create'; name: string }
  | { open: true; mode: 'rename'; project: ProjectIndexItem; name: string };

export function ProjectIndexPage({
  onOpenProject,
}: {
  onOpenProject: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectIndexItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectIndexItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProjects(await fetchProjectIndex());
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function closeEditor() {
    if (saving) return;
    setEditor({ open: false });
    setEditorError(null);
  }

  async function submitEditor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor.open) return;
    const name = editor.name.trim();
    if (!name) {
      setEditorError('请输入项目名称');
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      if (editor.mode === 'create') {
        const file = await createProject(name);
        const created = file.projects[0];
        setEditor({ open: false });
        onOpenProject(created.id);
        return;
      }
      await renameProject(editor.project.project.id, name);
      setEditor({ open: false });
      await load();
    } catch (error) {
      setEditorError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteProject(target.project.id);
      setProjects(items => items.filter(item => item.project.id !== target.project.id));
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }

  return (
    <section className="stable-scroll h-full overflow-y-auto bg-background">
      <div className="w-full px-4 py-8 sm:px-6 md:px-10 md:py-12">
        <header className="mb-8 space-y-2">
          <p className="text-xs uppercase tracking-label text-muted-foreground">项目目录</p>
          <h1 className="font-display text-display italic text-foreground">全部项目</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            每个项目保存自己的世界观、文件夹与美术、UI、视频资产。
          </p>
        </header>

        {loadError && (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              重试
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy={loading}>
          <button
            type="button"
            onClick={() => {
              setEditor({ open: true, mode: 'create', name: '' });
              setEditorError(null);
            }}
            className="group flex min-h-72 cursor-pointer flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-card/30 px-6 text-center transition-colors hover:border-input hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors group-hover:text-foreground">
              <Plus className="size-5" aria-hidden="true" />
            </span>
            <span className="space-y-1">
              <span className="block text-base font-medium text-foreground">新建项目</span>
              <span className="block text-xs text-muted-foreground">建立一个新的游戏资产空间</span>
            </span>
          </button>

          {loading && projects.length === 0
            ? Array.from({ length: 3 }, (_, index) => <ProjectCardSkeleton key={index} />)
            : projects.map(item => (
              <ProjectCard
                key={item.project.id}
                item={item}
                onOpen={() => onOpenProject(item.project.id)}
                onRename={() => {
                  setEditor({
                    open: true,
                    mode: 'rename',
                    project: item,
                    name: item.project.name,
                  });
                  setEditorError(null);
                }}
                onDelete={() => setDeleteTarget(item)}
              />
            ))}
        </div>
      </div>

      <Dialog open={editor.open} onOpenChange={open => { if (!open) closeEditor(); }}>
        {editor.open && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editor.mode === 'create' ? '新建项目' : '重命名项目'}</DialogTitle>
              <DialogDescription>
                项目名称可以随时修改，角色、UI 和视频资产不会因此移动。
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={submitEditor}>
              <div className="space-y-2">
                <Label htmlFor="project-name">项目名称</Label>
                <Input
                  id="project-name"
                  autoFocus
                  value={editor.name}
                  aria-invalid={Boolean(editorError)}
                  aria-describedby={editorError ? 'project-name-error' : undefined}
                  onChange={event => {
                    const name = event.target.value;
                    setEditor(current => current.open ? { ...current, name } : current);
                  }}
                />
                {editorError && (
                  <p id="project-name-error" role="alert" className="text-xs text-destructive">
                    {editorError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeEditor} disabled={saving}>
                  取消
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? '保存中…' : editor.mode === 'create' ? '创建并进入' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `删除项目「${deleteTarget.project.name}」？` : '删除项目？'}
        message="项目记录会被移除，原有资产文件不会从磁盘删除。"
        variant="destructive"
        confirmText="删除项目"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

function ProjectCard({
  item,
  onOpen,
  onRename,
  onDelete,
}: {
  item: ProjectIndexItem;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="group relative overflow-hidden bg-card/45 transition-colors hover:border-input">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`打开项目 ${item.project.name}`}
        className="block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        <ProjectCover paths={item.cover_paths} projectName={item.project.name} />
        <CardHeader className="min-h-24 pr-14">
          <CardTitle>{item.project.name}</CardTitle>
          <CardDescription>{formatActivity(item.activity_at)}</CardDescription>
        </CardHeader>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`管理项目 ${item.project.name}`}
            className="absolute bottom-2 right-2 size-11"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={onRename}>
              <Pencil aria-hidden="true" />
              重命名
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={onDelete}>
            <Trash2 aria-hidden="true" />
            删除项目
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
  );
}

function ProjectCover({ paths, projectName }: { paths: string[]; projectName: string }) {
  if (paths.length === 0) {
    return (
      <div className="grid aspect-[16/10] place-items-center border-b border-border bg-secondary/30 text-muted-foreground">
        <FolderPlus className="size-8" aria-hidden="true" />
      </div>
    );
  }
  const visible = paths.slice(0, 4);
  return (
    <div className={cn(
      'grid aspect-[16/10] overflow-hidden border-b border-border bg-secondary/30',
      visible.length > 1 && 'grid-cols-2',
      visible.length > 2 && 'grid-rows-2',
    )} aria-label={`${projectName} 项目封面`} role="img">
      {visible.map((path, index) => (
        <img
          key={path}
          src={`/api/gallery/image?path=${encodeURIComponent(path)}`}
          alt=""
          loading="lazy"
          className={cn(
            'size-full min-h-0 object-cover',
            visible.length === 3 && index === 0 && 'row-span-2',
            visible.length === 2 && 'row-span-2',
          )}
        />
      ))}
    </div>
  );
}

function ProjectCardSkeleton() {
  return (
    <Card aria-hidden="true" className="overflow-hidden bg-card/30">
      <div className="aspect-[16/10] animate-pulse border-b border-border bg-secondary/40 motion-reduce:animate-none" />
      <CardHeader className="min-h-24">
        <div className="h-4 w-2/3 animate-pulse rounded-sm bg-secondary motion-reduce:animate-none" />
        <div className="h-3 w-1/3 animate-pulse rounded-sm bg-secondary/70 motion-reduce:animate-none" />
      </CardHeader>
    </Card>
  );
}

function formatActivity(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚更新';
  return `更新于 ${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)}`;
}
