import { useMemo, useRef, useState } from 'react';
import { FileArchive, FolderOpen, Puzzle, Trash2 } from 'lucide-react';
import { deleteCanvasAgentSkill, importCanvasAgentSkill } from '@/api/canvas';
import { ApiError } from '@/api/http';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { cn } from '@/lib/utils';
import type { CanvasAgentSkill } from '@/schema/canvas';

/** 文件夹选择器给的是相对路径（含选中的那层目录名），服务端以 SKILL.md 所在目录为根。 */
function relativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CanvasAgentSkillPicker({ skills, selected, disabled, onSelect, onChanged }: {
  skills: CanvasAgentSkill[];
  selected: string | null;
  disabled?: boolean;
  onSelect: (name: string) => void;
  /** 导入或删除之后重新读取列表。 */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const archiveRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? skills.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(needle))
      : skills;
  }, [skills, query]);

  async function importFiles(files: File[], paths: string[]) {
    if (!files.length) return;
    setBusy(true);
    setNotice(null);
    try {
      let installed: CanvasAgentSkill;
      try {
        installed = await importCanvasAgentSkill(files, paths);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'SKILL_EXISTS')) throw error;
        if (!window.confirm(`${error.reason ?? '已有同名 Skill'}，覆盖吗？`)) return;
        installed = await importCanvasAgentSkill(files, paths, true);
      }
      setNotice({
        text: installed.has_scripts ? `已导入 ${installed.name}（自带脚本不会执行）` : `已导入 ${installed.name}`,
        error: false,
      });
      onChanged();
    } catch (error) {
      setNotice({ text: messageOf(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`删除 Skill「${name}」？`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteCanvasAgentSkill(name);
      onChanged();
    } catch (error) {
      setNotice({ text: messageOf(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        title="Skill"
        aria-label="选择 Skill"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40',
          selected && 'text-primary',
        )}
      ><Puzzle className="size-4" /></button>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        direction="up"
        align="start"
        autoFocus
        aria-label="Skill"
        className="flex w-72 flex-col rounded-xl border border-border bg-popover p-1.5 shell-glow"
      >
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索 Skill"
          aria-label="搜索 Skill"
          className="mb-1 h-8 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary"
        />
        <div role="listbox" aria-label="Skill 列表" className="max-h-64 overflow-y-auto">
          {skills.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">还没有 Skill</p>}
          {skills.length > 0 && matches.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">没有匹配的 Skill</p>}
          {matches.map(item => (
            <div key={item.name} className="group flex items-start gap-1 rounded-md hover:bg-secondary">
              <button
                type="button"
                role="option"
                aria-selected={item.name === selected}
                onClick={() => { onSelect(item.name); setOpen(false); }}
                className={cn('min-w-0 flex-1 px-2 py-1.5 text-left', item.name === selected && 'text-primary')}
              >
                <span className="block truncate text-xs font-medium">{item.name}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span>
              </button>
              <button
                type="button"
                title="删除"
                aria-label={`删除 Skill ${item.name}`}
                disabled={busy}
                onClick={() => void remove(item.name)}
                className="mt-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
              ><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
        {notice && (
          <p role={notice.error ? 'alert' : 'status'} className={cn('px-2 py-1.5 text-xs', notice.error ? 'text-destructive' : 'text-muted-foreground')}>{notice.text}</p>
        )}
        <div className="mt-1 flex gap-1 border-t border-border pt-1.5">
          <button type="button" disabled={busy} onClick={() => archiveRef.current?.click()} className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40">
            <FileArchive className="size-3.5" />导入 zip / SKILL.md
          </button>
          <button type="button" disabled={busy} onClick={() => folderRef.current?.click()} className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40">
            <FolderOpen className="size-3.5" />导入文件夹
          </button>
        </div>
        <input
          ref={archiveRef}
          type="file"
          accept=".zip,.md"
          aria-label="选择 Skill 压缩包或 SKILL.md"
          className="sr-only"
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void importFiles(files, []);
          }}
        />
        <input
          ref={folderRef}
          type="file"
          aria-label="选择 Skill 文件夹"
          className="sr-only"
          // 非标准属性：React 的类型里没有 webkitdirectory，用展开对象传进去。
          {...{ webkitdirectory: '', directory: '' }}
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void importFiles(files, files.map(relativePath));
          }}
        />
      </ToolbarPopover>
    </>
  );
}
