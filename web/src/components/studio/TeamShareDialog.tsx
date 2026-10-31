import { useEffect, useMemo, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';

import {
  ProfileRequiredError,
  TeamRefsTooLargeError,
  fetchProfile,
  listTeamLibraries,
  saveProfile,
  shareToTeamLibrary,
} from '@/api/teamLibraries';
import type {
  TeamLibraryIndexEntry,
  TeamLibraryView,
  TeamShareRequest,
  TeamShareSource,
} from '@/schema/teamLibrary';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MountTeamLibraryDialog } from '@/components/team/MountTeamLibraryDialog';
import { CategoryField, TagField, parseTags } from '@/components/assets/TagField';
import { DEFAULT_CANVAS_CATEGORIES } from '@/schema/canvas';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SwapLabel } from '@/components/ui/swap-label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface TeamShareDialogRequest {
  source: TeamShareSource;
  defaultTitle: string;
  /** 只传图片 URL（渲染成 <img>）；视频等其他媒体不传。 */
  previewUrl?: string | null;
  /** 来源已定稿时的类别：预填进类别框，作者可改可清空。 */
  defaultCategory?: string | null;
}

export interface TeamShareDialogProps {
  /**
   * null = 关闭。必须是稳定引用（放在调用方 state 里）：引用一变就视为重新打开，
   * 表单重置并重新拉取显示名与团队库。
   */
  request: TeamShareDialogRequest | null;
  onClose(): void;
  onShared(entry: TeamLibraryIndexEntry, libraryName: string): void;
  /** 画布传当前画布项目 id：只列挂在这个画布上的库。Studio 不传，列全部。 */
  projectId?: string;
}

const TITLE_MAX_LENGTH = 120;
const MAX_TAGS = 20;


/** 同一个库可能挂在多个画布上：只留可达的，按 library_id 去重。 */
function reachableLibraries(views: TeamLibraryView[]): TeamLibraryView[] {
  const seen = new Set<string>();
  return views.filter(view => {
    if (!view.reachable || seen.has(view.library_id)) return false;
    seen.add(view.library_id);
    return true;
  });
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function TeamShareDialog({ request, onClose, onShared, projectId }: TeamShareDialogProps) {
  const [libraries, setLibraries] = useState<TeamLibraryView[]>([]);
  const [libraryId, setLibraryId] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [largeRefs, setLargeRefs] = useState<TeamRefsTooLargeError | null>(null);
  const [mountOpen, setMountOpen] = useState(false);
  // state 要等下一次渲染才生效；同一 tick 内的重复调用靠 ref 拦住。
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setLibraries([]);
    setLibraryId('');
    setNeedsName(false);
    setDisplayName('');
    setTitle(request.defaultTitle);
    setTags('');
    setCategory(request.defaultCategory ?? '');
    setError(null);
    setLargeRefs(null);
    setLoading(true);
    Promise.all([fetchProfile(), listTeamLibraries(projectId)])
      .then(([profile, views]) => {
        if (cancelled) return;
        const usable = reachableLibraries(views);
        setLibraries(usable);
        if (usable.length === 1) setLibraryId(usable[0].library_id);
        setNeedsName(!profile.display_name);
      })
      .catch(cause => {
        if (!cancelled) setError(errorMessage(cause, '读取团队库失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [request, projectId]);

  const library = useMemo(
    () => libraries.find(item => item.library_id === libraryId) ?? null,
    [libraries, libraryId],
  );
  const canSubmit = Boolean(request && library && title.trim())
    && parseTags(tags).length <= MAX_TAGS
    && (!needsName || Boolean(displayName.trim()))
    && !loading
    && !submitting;

  async function share(allowLarge: boolean) {
    if (!request || !library || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setLargeRefs(null);
    try {
      if (needsName) {
        await saveProfile(displayName.trim());
        setNeedsName(false);
      }
      const body: TeamShareRequest = {
        source: request.source,
        title: title.trim(),
        tags: parseTags(tags),
        category: category.trim() || null,
        ...(allowLarge ? { allow_large: true } : {}),
      };
      const entry = await shareToTeamLibrary(library.library_id, body);
      onShared(entry, library.name);
      onClose();
    } catch (cause) {
      if (cause instanceof TeamRefsTooLargeError) setLargeRefs(cause);
      else if (cause instanceof ProfileRequiredError) {
        setNeedsName(true);
        setError(cause.message);
      } else setError(errorMessage(cause, '分享失败'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const noLibrary = !loading && libraries.length === 0 && !error;

  // 就地挂载后只刷新库与署名，不重置已填的标题和标签。
  function afterMount() {
    Promise.all([fetchProfile(), listTeamLibraries(projectId)])
      .then(([profile, views]) => {
        const usable = reachableLibraries(views);
        setLibraries(usable);
        if (usable.length === 1) setLibraryId(usable[0].library_id);
        setNeedsName(!profile.display_name);
      })
      .catch(cause => setError(errorMessage(cause, '读取团队库失败')));
  }

  return (
    <>
      <Dialog open={Boolean(request)} onOpenChange={open => { if (!open && !submitting) onClose(); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="size-4" aria-hidden />
              分享到团队库
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {request?.previewUrl && (
              <img
                src={request.previewUrl}
                alt=""
                className="max-h-48 w-full rounded-md border border-border bg-secondary object-contain"
              />
            )}

            {noLibrary ? (
              <div className="flex items-center justify-between gap-3">
                <p role="status" className="text-sm text-muted-foreground">没有可用的团队库</p>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => setMountOpen(true)}>
                  挂载
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="team-share-library" className="text-xs font-normal text-muted-foreground">团队库</Label>
                <Select
                  value={libraryId}
                  onValueChange={setLibraryId}
                  disabled={loading || submitting || libraries.length === 0}
                >
                  <SelectTrigger id="team-share-library">
                    <SelectValue placeholder={loading ? '正在读取…' : '选择团队库…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {libraries.map(item => (
                      <SelectItem key={item.library_id} value={item.library_id}>{item.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {needsName && (
              <div className="space-y-2">
                <Label htmlFor="team-share-name" className="text-xs font-normal text-muted-foreground">显示名</Label>
                <Input
                  id="team-share-name"
                  value={displayName}
                  maxLength={40}
                  disabled={submitting}
                  onChange={event => setDisplayName(event.target.value)}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="team-share-title" className="text-xs font-normal text-muted-foreground">标题</Label>
              <Input
                id="team-share-title"
                value={title}
                maxLength={TITLE_MAX_LENGTH}
                disabled={submitting}
                onChange={event => setTitle(event.target.value)}
              />
            </div>

            <CategoryField value={category} onChange={setCategory} disabled={submitting}
              options={[...new Set([...(request?.defaultCategory ? [request.defaultCategory] : []), ...DEFAULT_CANVAS_CATEGORIES])]} />

            <TagField value={tags} onChange={setTags} />

            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" disabled={submitting} onClick={onClose}>
              取消
            </Button>
            <Button type="button" className="min-h-11" disabled={!canSubmit} onClick={() => void share(false)}>
              <SwapLabel active={Boolean(submitting)} on="分享中…" off="分享" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={largeRefs !== null}
        title="参考内容较大"
        message={largeRefs?.message ?? ''}
        confirmText="分享"
        onConfirm={() => void share(true)}
        onCancel={() => setLargeRefs(null)}
      />
      <MountTeamLibraryDialog open={mountOpen} currentProjectId={projectId} onClose={() => setMountOpen(false)}
        onMounted={afterMount} />
    </>
  );
}
