import { promptFromAsset } from '@/lib/promptVariables';
import {
  ChevronLeft,
  ExternalLink,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Plus,
  Search,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import {
  DuplicateCreationAssetError,
  createPromptCreationAsset,
  creationAssetMediaUrl,
  deleteCreationAsset,
  listCreationAssets,
  markCreationAssetUsed,
  saveMediaCreationAssetFromPath,
  updateMediaCreationAsset,
  updatePromptCreationAsset,
  uploadMediaCreationAsset,
} from '@/api/creationAssets';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  addPromptVariableRange,
  promptTemplateFromSegments,
  segmentsFromPromptTemplate,
  updatePromptVariableRanges,
  type PromptVariableRange,
} from '@/lib/promptAssetTemplate';
import { cn } from '@/lib/utils';
import {
  renderCreationPrompt,
  type CreationAsset,
  type CreationAssetKind,
  type CreationAssetRecommendation,
  type CreationMediaAssetContent,
  type CreationPromptSegment,
} from '@/schema/creationAssets';

export type CreationAssetSaveRequest =
  | {
    requestId: string;
    kind: 'prompt';
    title?: string;
    segments: CreationPromptSegment[];
    projectId?: string;
  }
  | {
    requestId: string;
    kind: 'media';
    title?: string;
    file?: File;
    sourcePath?: string;
    previewUrl?: string;
    projectId?: string;
  };

export interface CreationAssetPanelProps {
  className?: string;
  projectId?: string;
  canvasTargets?: { projectId: string; name: string }[];
  initialKind?: CreationAssetKind;
  saveRequest?: CreationAssetSaveRequest | null;
  onSaveRequestHandled?: (requestId: string) => void;
  onClose: () => void;
  onUsePrompt: (
    asset: CreationAsset,
    renderedPrompt: string,
  ) => void;
  onUseMedia: (asset: CreationAsset, content: CreationMediaAssetContent) => void;
}

export interface CreationAssetPanelHandle {
  requestClose: () => void;
  requestTransition: (action: () => void) => void;
}

type PromptEditorState = {
  assetId?: string;
  title: string;
  text: string;
  variables: PromptVariableRange[];
  tags: string;
  /** 推荐配置（可选）：模型 id + 每行一条 key=value 的参数。 */
  recommendationMode: 'image' | 'video';
  recommendationModel: string;
  recommendationParams: string;
  initialSignature: string;
};

type MediaEditorState = {
  assetId?: string;
  title: string;
  tags: string;
  file?: File;
  sourcePath?: string;
  previewUrl?: string;
  projectId?: string;
  initialSignature: string;
};

export const CreationAssetPanel = forwardRef<CreationAssetPanelHandle, CreationAssetPanelProps>(function CreationAssetPanel({
  className,
  projectId,
  canvasTargets = [],
  initialKind = 'prompt',
  saveRequest,
  onSaveRequestHandled,
  onClose,
  onUsePrompt,
  onUseMedia,
}: CreationAssetPanelProps, ref) {
  const [kind, setKind] = useState<CreationAssetKind>(initialKind);
  const [scope, setScope] = useState<'all' | 'project'>(projectId ? 'project' : 'all');
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promptEditor, setPromptEditor] = useState<PromptEditorState | null>(null);
  const [mediaEditor, setMediaEditor] = useState<MediaEditorState | null>(null);
  const [variableName, setVariableName] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicatePromptTitle, setDuplicatePromptTitle] = useState<string | null>(null);
  const [duplicateMediaAssetId, setDuplicateMediaAssetId] = useState<string | null>(null);
  const [addToCanvasAfterSave, setAddToCanvasAfterSave] = useState(false);
  const [canvasPickerAsset, setCanvasPickerAsset] = useState<CreationAsset | null>(null);
  const [linkedCanvas, setLinkedCanvas] = useState<{ projectId: string; name: string } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CreationAsset | null>(null);
  const leaveActionRef = useRef<(() => void) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selected = assets.find(asset => asset.asset_id === selectedId) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAssets = useMemo(() => assets.filter(asset => {
    if (!normalizedQuery) return true;
    const preview = asset.content.kind === 'prompt'
      ? renderCreationPrompt(asset.content.segments)
      : asset.content.filename;
    return asset.title.toLocaleLowerCase().includes(normalizedQuery)
      || preview.toLocaleLowerCase().includes(normalizedQuery)
      || asset.tags.some(tag => tag.toLocaleLowerCase().includes(normalizedQuery));
  }), [assets, normalizedQuery]);

  const editorDirty = promptEditor
    ? promptEditor.initialSignature !== promptEditorSignature(promptEditor)
    : mediaEditor
      ? mediaEditor.initialSignature !== mediaEditorSignature(mediaEditor) || Boolean(mediaEditor.file)
      : false;

  async function refresh(preferredId?: string) {
    try {
      setError(null);
      const response = await listCreationAssets({
        kind,
        scope: projectId ? scope : 'all',
        projectId,
      });
      setAssets(response.assets);
      setSelectedId(current => {
        const target = preferredId ?? current;
        return response.assets.some(asset => asset.asset_id === target) ? target : null;
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  useEffect(() => {
    void refresh();
  }, [kind, projectId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setKind(initialKind), [initialKind]);

  useEffect(() => {
    if (!saveRequest) return;
    setKind(saveRequest.kind);
    setSelectedId(null);
    setCanvasPickerAsset(null);
    setLinkedCanvas(null);
    setDuplicatePromptTitle(null);
    setDuplicateMediaAssetId(null);
    setError(null);
    if (saveRequest.kind === 'prompt') {
      const template = promptTemplateFromSegments(saveRequest.segments);
      const draft = {
        title: saveRequest.title?.trim() || defaultPromptTitle(template.text),
        text: template.text,
        variables: template.variables,
        tags: '',
        recommendationMode: 'image' as const,
        recommendationModel: '',
        recommendationParams: '',
      };
      setPromptEditor({ ...draft, initialSignature: promptEditorSignature(draft) });
      setMediaEditor(null);
    } else {
      const draft = {
        title: saveRequest.title?.trim() || defaultMediaTitle(saveRequest),
        tags: '',
        file: saveRequest.file,
        sourcePath: saveRequest.sourcePath,
        previewUrl: saveRequest.previewUrl,
        projectId: saveRequest.projectId,
      };
      setMediaEditor({ ...draft, initialSignature: mediaEditorSignature(draft) });
      setPromptEditor(null);
    }
    onSaveRequestHandled?.(saveRequest.requestId);
  }, [onSaveRequestHandled, saveRequest]);

  function openAsset(asset: CreationAsset) {
    setSelectedId(asset.asset_id);
    setPromptEditor(null);
    setMediaEditor(null);
    setCanvasPickerAsset(null);
    setLinkedCanvas(null);
    setError(null);
  }

  function requestLeave(action: () => void) {
    if (!editorDirty) {
      action();
      return;
    }
    leaveActionRef.current = action;
    setDiscardOpen(true);
  }

  function clearEditor() {
    setPromptEditor(null);
    setMediaEditor(null);
    setSelection(null);
    setVariableName('');
    setDuplicatePromptTitle(null);
    setDuplicateMediaAssetId(null);
  }

  function back() {
    requestLeave(() => {
      const editingId = promptEditor?.assetId ?? mediaEditor?.assetId;
      clearEditor();
      setSelectedId(editingId ?? null);
      setCanvasPickerAsset(null);
      setLinkedCanvas(null);
      setError(null);
    });
  }

  function close() {
    requestLeave(onClose);
  }

  useImperativeHandle(ref, () => ({
    requestClose: close,
    requestTransition: requestLeave,
  }));

  async function applyAsset(asset: CreationAsset) {
    setBusy(true);
    setError(null);
    try {
      const updated = await markCreationAssetUsed(asset.asset_id, projectId);
      if (updated.content.kind === 'prompt') {
        onUsePrompt(updated, promptFromAsset(updated.content.segments));
      } else {
        onUseMedia(updated, updated.content);
      }
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function beginPromptEdit(asset?: CreationAsset) {
    const content = asset?.content.kind === 'prompt' ? asset.content : null;
    const template = content
      ? promptTemplateFromSegments(content.segments)
      : { text: '', variables: [] };
    const draft = {
      assetId: asset?.asset_id,
      title: asset?.title ?? '',
      text: template.text,
      variables: template.variables,
      tags: asset?.tags.join(', ') ?? '',
      recommendationMode: asset?.recommendation?.mode ?? 'image',
      recommendationModel: asset?.recommendation?.model ?? '',
      recommendationParams: formatRecommendationParams(asset?.recommendation?.params),
    };
    setSelectedId(null);
    setMediaEditor(null);
    setPromptEditor({ ...draft, initialSignature: promptEditorSignature(draft) });
    setSelection(null);
    setVariableName('');
  }

  function beginMediaEdit(asset: CreationAsset) {
    if (asset.content.kind !== 'media') return;
    const draft = {
      assetId: asset.asset_id,
      title: asset.title,
      tags: asset.tags.join(', '),
      previewUrl: creationAssetMediaUrl(asset.asset_id),
    };
    setSelectedId(null);
    setPromptEditor(null);
    setMediaEditor({ ...draft, initialSignature: mediaEditorSignature(draft) });
  }

  async function savePrompt(addToCanvas = false, allowDuplicate = false) {
    if (!promptEditor?.title.trim() || !promptEditor.text.trim()) {
      setError('标题和提示词正文不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const segments = segmentsFromPromptTemplate(promptEditor.text, promptEditor.variables);
      if (!promptEditor.assetId && !allowDuplicate) {
        const duplicateCandidates = projectId && scope === 'project'
          ? (await listCreationAssets({ kind: 'prompt', scope: 'all' })).assets
          : assets;
        const duplicate = duplicateCandidates.find(asset => asset.content.kind === 'prompt'
          && renderCreationPrompt(asset.content.segments) === renderCreationPrompt(segments));
        if (duplicate) {
          setDuplicatePromptTitle(duplicate.title);
          setAddToCanvasAfterSave(addToCanvas);
          return;
        }
      }
      const input = {
        title: promptEditor.title.trim(),
        segments,
        tags: parseTags(promptEditor.tags),
        recommendation: recommendationFromEditor(promptEditor),
      };
      const saved = promptEditor.assetId
        ? await updatePromptCreationAsset(promptEditor.assetId, input)
        : await createPromptCreationAsset({ ...input, projectId });
      setDuplicatePromptTitle(null);
      await finishSave(saved, addToCanvas);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveMedia(addToCanvas = false, allowExisting = false) {
    if (!mediaEditor?.title.trim()) {
      setError('媒体资产标题不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const common = { title: mediaEditor.title.trim(), tags: parseTags(mediaEditor.tags) };
      let saved: CreationAsset;
      if (mediaEditor.assetId) {
        saved = await updateMediaCreationAsset(mediaEditor.assetId, { ...common, file: mediaEditor.file });
      } else if (mediaEditor.file) {
        saved = await uploadMediaCreationAsset({
          ...common,
          file: mediaEditor.file,
          allowExisting,
          projectId: mediaEditor.projectId ?? projectId,
        });
      } else if (mediaEditor.sourcePath) {
        saved = await saveMediaCreationAssetFromPath({
          ...common,
          sourcePath: mediaEditor.sourcePath,
          allowExisting,
          projectId: mediaEditor.projectId ?? projectId,
        });
      } else {
        throw new Error('没有可保存的媒体文件。');
      }
      setDuplicateMediaAssetId(null);
      await finishSave(saved, addToCanvas);
    } catch (caught) {
      if (caught instanceof DuplicateCreationAssetError) {
        setDuplicateMediaAssetId(caught.assetId);
        setAddToCanvasAfterSave(addToCanvas);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function finishSave(saved: CreationAsset, addToCanvas: boolean) {
    clearEditor();
    await refresh(saved.asset_id);
    if (addToCanvas && canvasTargets.length > 0) {
      setSelectedId(null);
      setCanvasPickerAsset(saved);
      setLinkedCanvas(null);
    } else {
      setSelectedId(saved.asset_id);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCreationAsset(deleteTarget.asset_id);
      setDeleteTarget(null);
      clearEditor();
      setSelectedId(null);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function connectToCanvas(target: { projectId: string; name: string }) {
    if (!canvasPickerAsset) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await markCreationAssetUsed(canvasPickerAsset.asset_id, target.projectId);
      setCanvasPickerAsset(updated);
      setLinkedCanvas(target);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function captureSelection() {
    const editor = textareaRef.current;
    if (!editor || editor.selectionEnd <= editor.selectionStart) {
      setSelection(null);
      return;
    }
    setSelection({ start: editor.selectionStart, end: editor.selectionEnd });
  }

  function addVariable() {
    if (!promptEditor || !selection || !variableName.trim()) return;
    setPromptEditor({
      ...promptEditor,
      variables: addPromptVariableRange(promptEditor.variables, {
        name: variableName,
        start: selection.start,
        end: selection.end,
      }),
    });
    setVariableName('');
    setSelection(null);
    setDuplicatePromptTitle(null);
    textareaRef.current?.focus();
  }

  function changePromptText(event: ChangeEvent<HTMLTextAreaElement>) {
    if (!promptEditor) return;
    const nextText = event.target.value;
    setDuplicatePromptTitle(null);
    setPromptEditor({
      ...promptEditor,
      text: nextText,
      variables: updatePromptVariableRanges(promptEditor.text, nextText, promptEditor.variables),
    });
  }

  const isEditing = Boolean(promptEditor || mediaEditor || canvasPickerAsset);
  const editingAsset = assets.find(asset => asset.asset_id === (promptEditor?.assetId ?? mediaEditor?.assetId));

  return (
    <aside aria-label="创作资产" className={cn('fixed bottom-56 right-4 top-24 z-40 flex w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover shell-glow', className)}>
      <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {(selected || isEditing) && <Button variant="ghost" size="icon" aria-label="返回资产列表" onClick={back}><ChevronLeft /></Button>}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{canvasPickerAsset ? '加入画布' : promptEditor?.assetId || mediaEditor?.assetId ? '编辑资产' : isEditing ? '保存为创作资产' : selected?.title ?? '创作资产'}</p>
            <p className="text-xs text-muted-foreground">创作台与画布共用</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="关闭创作资产" onClick={close}><X /></Button>
      </header>

      {error && <p role="alert" className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      {!selected && !isEditing && (
        <>
          <div className="grid grid-cols-2 border-b border-border p-1.5" role="group" aria-label="资产类型">
            <PanelTab active={kind === 'prompt'} onClick={() => setKind('prompt')}><FileText />提示词</PanelTab>
            <PanelTab active={kind === 'media'} onClick={() => setKind('media')}><FileImage />媒体</PanelTab>
          </div>
          <div className="space-y-2 border-b border-border p-3">
            {projectId && <div className="flex gap-1" role="group" aria-label="资产范围"><ScopeButton active={scope === 'all'} onClick={() => setScope('all')}>全部资产</ScopeButton><ScopeButton active={scope === 'project'} onClick={() => setScope('project')}>本项目</ScopeButton></div>}
            <label className="relative block">
              <span className="sr-only">搜索创作资产</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、正文或标签" className="pl-9" />
            </label>
            {kind === 'prompt' && <Button variant="outline" size="sm" className="w-full" onClick={() => beginPromptEdit()}><Plus />新建提示词资产</Button>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {visibleAssets.length ? visibleAssets.map(asset => <AssetCard key={asset.asset_id} asset={asset} onOpen={() => openAsset(asset)} />) : (
              <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-border px-8 text-center text-xs leading-relaxed text-muted-foreground">{normalizedQuery ? '没有匹配的创作资产' : kind === 'prompt' ? '还没有提示词资产' : '还没有媒体资产'}</div>
            )}
          </div>
        </>
      )}

      {promptEditor && (
        <PromptEditor
          state={promptEditor}
          busy={busy}
          textareaRef={textareaRef}
          variableName={variableName}
          selection={selection}
          duplicateTitle={duplicatePromptTitle ?? undefined}
          showSaveAndAddCanvas={canvasTargets.length > 0 && !promptEditor.assetId}
          onChange={next => { setPromptEditor(next); setDuplicatePromptTitle(null); }}
          onTextChange={changePromptText}
          onCaptureSelection={captureSelection}
          onVariableNameChange={setVariableName}
          onAddVariable={addVariable}
          onSave={() => void savePrompt(false)}
          onSaveAndAddCanvas={() => void savePrompt(true)}
          onConfirmDuplicate={() => void savePrompt(addToCanvasAfterSave, true)}
          onCancelDuplicate={() => setDuplicatePromptTitle(null)}
          onDelete={editingAsset ? () => setDeleteTarget(editingAsset) : undefined}
        />
      )}

      {mediaEditor && (
        <MediaEditor
          state={mediaEditor}
          busy={busy}
          duplicateTitle={assets.find(asset => asset.asset_id === duplicateMediaAssetId)?.title}
          showSaveAndAddCanvas={canvasTargets.length > 0 && !mediaEditor.assetId}
          onChange={setMediaEditor}
          onSave={() => void saveMedia(false)}
          onSaveAndAddCanvas={() => void saveMedia(true)}
          onConfirmDuplicate={() => void saveMedia(addToCanvasAfterSave, true)}
          onCancelDuplicate={() => setDuplicateMediaAssetId(null)}
          onDelete={editingAsset ? () => setDeleteTarget(editingAsset) : undefined}
        />
      )}

      {canvasPickerAsset && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="rounded-lg border border-border bg-card p-3"><p className="text-sm font-medium">{canvasPickerAsset.title}</p><p className="mt-1 text-xs text-muted-foreground">选择一个画布，资产会出现在该画布的“本项目”范围中。</p></div>
          {!linkedCanvas && canvasTargets.map(target => <button key={target.projectId} type="button" disabled={busy} className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-3 text-left text-sm hover:bg-secondary disabled:opacity-50" onClick={() => void connectToCanvas(target)}><span className="truncate">{target.name}</span><span className="text-xs text-muted-foreground">加入</span></button>)}
          {linkedCanvas && <div role="status" className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs">已加入“{linkedCanvas.name}”。<a className="ml-1 inline-flex items-center gap-1 text-primary hover:underline" href={`/canvas/${encodeURIComponent(linkedCanvas.projectId)}`}>打开画布<ExternalLink className="size-3" /></a></div>}
        </div>
      )}

      {selected && <AssetDetail asset={selected} busy={busy} onUse={() => void applyAsset(selected)} onEdit={() => selected.kind === 'prompt' ? beginPromptEdit(selected) : beginMediaEdit(selected)} />}

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent hideClose>
          <DialogHeader><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前编辑内容还没有保存。</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setDiscardOpen(false)}>继续编辑</Button><Button onClick={() => { setDiscardOpen(false); const action = leaveActionRef.current; leaveActionRef.current = null; action?.(); }}>放弃修改</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <DialogContent hideClose>
          <DialogHeader><DialogTitle>删除“{deleteTarget?.title}”？</DialogTitle><DialogDescription>删除后不可恢复。已经使用过的提示词、媒体和来源名称快照不会受影响。</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>{busy ? '删除中…' : '确认删除'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
});

function AssetCard({ asset, onOpen }: { asset: CreationAsset; onOpen: () => void }) {
  return (
    <button type="button" className="mb-2 w-full rounded-lg border border-border bg-card p-3 text-left outline-none hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-primary" onClick={onOpen}>
      {asset.content.kind === 'media' && <MediaPreview assetId={asset.asset_id} content={asset.content} alt="" className="mb-3 aspect-[4/3] w-full rounded-md bg-secondary object-cover" />}
      <p className="truncate text-sm font-medium">{asset.title}</p>
      {asset.content.kind === 'prompt' ? <PromptPreview segments={asset.content.segments} /> : <p className="mt-1 truncate text-xs text-muted-foreground">{asset.content.filename}</p>}
      <TagList tags={asset.tags} />
    </button>
  );
}

/** 服务端能存的媒体类型（与 creation_assets.MEDIA_SUFFIXES 一致）。 */
const MEDIA_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4';

/** 已入库的媒体：图片直接显示，视频/音频给原生播放器。 */
function MediaPreview({ assetId, content, alt, className }: {
  assetId: string;
  content: CreationMediaAssetContent;
  alt: string;
  className: string;
}) {
  const src = creationAssetMediaUrl(assetId);
  if (content.mime_type.startsWith('image/')) return <img src={src} alt={alt} loading="lazy" className={className} />;
  if (content.mime_type.startsWith('video/')) return <video src={src} muted playsInline preload="metadata" className={className} />;
  if (content.mime_type.startsWith('audio/')) return <audio src={src} controls preload="metadata" className="w-full" />;
  return null;
}

/** 还没上传的本地文件：图片出缩略图，其余用图标占位。 */
function PendingFilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  const isImage = file.type.startsWith('image/');
  useEffect(() => {
    if (!isImage) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file, isImage]);
  if (isImage) {
    return url ? <img src={url} alt="待保存媒体预览" className="aspect-square w-full rounded-lg border border-border object-contain" /> : null;
  }
  const Icon = file.type.startsWith('audio/') ? FileAudio : FileVideo;
  return (
    <div className="grid aspect-square w-full place-items-center gap-2 rounded-lg border border-border text-muted-foreground">
      <Icon className="size-8" />
      <p className="max-w-full truncate px-4 text-xs">{file.name}</p>
    </div>
  );
}

function PromptPreview({ segments }: { segments: CreationPromptSegment[] }) {
  return <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{segments.map((segment, index) => segment.kind === 'text' ? segment.text : <span key={`${segment.name}-${index}`} className="mx-0.5 rounded border border-border bg-secondary px-1"><span className="text-muted-foreground">{segment.name}：</span><span className="text-foreground/80">{segment.default_value}</span></span>)}</p>;
}

function PromptEditor({ state, busy, textareaRef, variableName, selection, duplicateTitle, showSaveAndAddCanvas, onChange, onTextChange, onCaptureSelection, onVariableNameChange, onAddVariable, onSave, onSaveAndAddCanvas, onConfirmDuplicate, onCancelDuplicate, onDelete }: {
  state: PromptEditorState;
  busy: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  variableName: string;
  selection: { start: number; end: number } | null;
  duplicateTitle?: string;
  showSaveAndAddCanvas: boolean;
  onChange: (state: PromptEditorState) => void;
  onTextChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onCaptureSelection: () => void;
  onVariableNameChange: (value: string) => void;
  onAddVariable: () => void;
  onSave: () => void;
  onSaveAndAddCanvas: () => void;
  onConfirmDuplicate: () => void;
  onCancelDuplicate: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <Field label="标题"><Input value={state.title} onChange={event => onChange({ ...state, title: event.target.value })} placeholder="给这条提示词起个名字" /></Field>
      <Field label="提示词正文"><textarea ref={textareaRef} rows={9} value={state.text} onChange={onTextChange} onSelect={onCaptureSelection} placeholder="输入可复用的提示词正文" className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring" /></Field>
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="text-sm font-medium">变量</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">选中正文中的内容，输入变量名。选中文字就是默认内容。</p>
        <div className="mt-3 flex gap-2"><Input value={variableName} onChange={event => onVariableNameChange(event.target.value)} placeholder={selection ? '例如：主体' : '先在正文中选中内容'} disabled={!selection} /><Button size="sm" disabled={!selection || !variableName.trim()} onClick={onAddVariable}>设为变量</Button></div>
        {state.variables.length > 0 && <div className="mt-3 space-y-2">{state.variables.map(variable => <div key={variable.id} className="flex items-center gap-2 rounded-md bg-secondary px-2 py-1.5 text-xs"><span className="text-muted-foreground">{variable.name}：</span><span className="min-w-0 flex-1 truncate">{state.text.slice(variable.start, variable.end)}</span><button type="button" aria-label={`移除变量 ${variable.name}`} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground" onClick={() => onChange({ ...state, variables: state.variables.filter(item => item.id !== variable.id) })}><X className="size-3.5" /></button></div>)}</div>}
      </div>
      <TagField value={state.tags} onChange={tags => onChange({ ...state, tags })} />
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="text-sm font-medium">推荐配置</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">可选。Agent 选用这条提示词时按此定模型与参数；填模型 id，不填别名。</p>
        <div className="mt-3 grid grid-cols-[auto_1fr] gap-2">
          <select aria-label="推荐模式" value={state.recommendationMode} onChange={event => onChange({ ...state, recommendationMode: event.target.value as 'image' | 'video' })} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"><option value="image">图片</option><option value="video">视频</option></select>
          <Input aria-label="推荐模型" value={state.recommendationModel} onChange={event => onChange({ ...state, recommendationModel: event.target.value })} placeholder="模型 id，如 gpt-image-2" />
        </div>
        <textarea aria-label="推荐参数" rows={3} value={state.recommendationParams} onChange={event => onChange({ ...state, recommendationParams: event.target.value })} placeholder={'每行一条，如\nquality=high\nsize=2048x2048'} className="mt-2 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      {duplicateTitle ? <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed"><p>提示词正文与“{duplicateTitle}”相同，仍可按你的意图保存为另一条资产。</p><div className="mt-3 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onCancelDuplicate}>取消</Button><Button size="sm" disabled={busy} onClick={onConfirmDuplicate}>仍然保存</Button></div></div> : <div className="grid gap-2"><Button className="w-full" disabled={busy} onClick={onSave}>{busy ? '保存中…' : state.assetId ? '保存修改' : '保存提示词资产'}</Button>{showSaveAndAddCanvas && <Button variant="outline" className="w-full" disabled={busy} onClick={onSaveAndAddCanvas}>保存并加入画布</Button>}</div>}
      {onDelete && <DeleteAssetButton disabled={busy} onClick={onDelete} />}
    </div>
  );
}

function MediaEditor({ state, busy, duplicateTitle, showSaveAndAddCanvas, onChange, onSave, onSaveAndAddCanvas, onConfirmDuplicate, onCancelDuplicate, onDelete }: {
  state: MediaEditorState;
  busy: boolean;
  duplicateTitle?: string;
  showSaveAndAddCanvas: boolean;
  onChange: (state: MediaEditorState) => void;
  onSave: () => void;
  onSaveAndAddCanvas: () => void;
  onConfirmDuplicate: () => void;
  onCancelDuplicate: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {state.file ? <PendingFilePreview file={state.file} /> : state.previewUrl || state.sourcePath ? <img src={state.previewUrl || state.sourcePath} alt="媒体资产预览" className="aspect-square w-full rounded-lg border border-border object-contain" /> : null}
      {state.assetId && <label className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-secondary focus-within:ring-1 focus-within:ring-primary"><FileImage className="size-4" />{state.file ? '重新选择文件' : '替换文件（可选）'}<input type="file" accept={MEDIA_ACCEPT} className="sr-only" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) onChange({ ...state, file }); event.target.value = ''; }} /></label>}
      <Field label="标题"><Input value={state.title} onChange={event => onChange({ ...state, title: event.target.value })} /></Field>
      <TagField value={state.tags} onChange={tags => onChange({ ...state, tags })} />
      {duplicateTitle ? <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed"><p>这个文件已经在资产库的“{duplicateTitle}”中。可以复用原资产，不会创建重复副本。</p><div className="mt-3 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onCancelDuplicate}>取消</Button>{!state.assetId && <Button size="sm" disabled={busy} onClick={onConfirmDuplicate}>复用原资产</Button>}</div></div> : <div className="grid gap-2"><Button className="w-full" disabled={busy} onClick={onSave}>{busy ? '保存中…' : state.assetId ? '保存修改' : '保存媒体资产'}</Button>{showSaveAndAddCanvas && <Button variant="outline" className="w-full" disabled={busy} onClick={onSaveAndAddCanvas}>保存并加入画布</Button>}</div>}
      {onDelete && <DeleteAssetButton disabled={busy} onClick={onDelete} />}
    </div>
  );
}

function DeleteAssetButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return <div className="border-t border-border pt-4"><Button variant="ghost" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={disabled} onClick={onClick}><Trash2 />删除资产</Button></div>;
}

function AssetDetail({ asset, busy, onUse, onEdit }: {
  asset: CreationAsset;
  busy: boolean;
  onUse: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {asset.content.kind === 'media' && <MediaPreview assetId={asset.asset_id} content={asset.content} alt={asset.title} className="aspect-square w-full rounded-lg border border-border bg-secondary object-contain" />}
      <h2 className="mt-3 text-base font-medium">{asset.title}</h2>
      {asset.content.kind === 'prompt' && <PromptPreview segments={asset.content.segments} />}
      <TagList tags={asset.tags} />
      {asset.recommendation && <p className="mt-2 truncate text-xs text-muted-foreground" title={recommendationSummary(asset.recommendation)}>推荐：{recommendationSummary(asset.recommendation)}</p>}
      <div className="mt-4 flex gap-2"><Button className="flex-1" disabled={busy} onClick={onUse}>使用</Button><Button variant="outline" disabled={busy} onClick={onEdit}>编辑</Button></div>
    </div>
  );
}

function PanelTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn('flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary [&_svg]:size-4', active && 'bg-secondary text-foreground')}>{children}</button>;
}

function ScopeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn('rounded-full border border-transparent px-3 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary', active && 'border-border bg-secondary text-foreground')}>{children}</button>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5"><span className="flex items-center justify-between text-xs text-muted-foreground"><span>{label}</span>{hint && <span className="max-w-48 truncate">{hint}</span>}</span>{children}</label>;
}

function TagField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const current = new Set(parseTags(value));
  const [draft, setDraft] = useState('');
  const commitDraft = () => { const additions = parseTags(draft); if (!additions.length) return; onChange([...parseTags(value), ...additions].join(', ')); setDraft(''); };
  return (
    <Field label="标签">
      <div className="relative"><Tags className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitDraft} onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ',') return; event.preventDefault(); commitDraft(); }} placeholder="输入标签，按 Enter 添加" className="pl-9" /></div>
      {current.size > 0 && <div className="flex flex-wrap gap-1.5 pt-1">{[...current].map(tag => <span key={tag} className="group inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-accent hover:text-foreground">{tag}<button type="button" aria-label={`移除标签 ${tag}`} className="rounded-full transition-colors group-hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => onChange(parseTags(value).filter(item => item !== tag).join(', '))}><X className="size-3" /></button></span>)}</div>}
    </Field>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5">{tags.map(tag => <span key={tag} className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{tag}</span>)}</div>;
}

function promptEditorSignature(state: Omit<PromptEditorState, 'assetId' | 'initialSignature'>): string {
  const { title, text, variables, tags, recommendationMode, recommendationModel, recommendationParams } = state;
  return JSON.stringify({ title, text, variables, tags, recommendationMode, recommendationModel, recommendationParams });
}

function formatRecommendationParams(params?: Record<string, string | number | boolean>): string {
  return Object.entries(params ?? {}).map(([key, value]) => `${key}=${String(value)}`).join('\n');
}

/** 每行 key=value；数字与 true/false 转成对应类型，其余按字符串。模型留空即不带推荐。 */
function recommendationFromEditor(state: PromptEditorState): CreationAssetRecommendation | null {
  const model = state.recommendationModel.trim();
  if (!model) return null;
  const params: Record<string, string | number | boolean> = {};
  for (const line of state.recommendationParams.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key || !raw) continue;
    if (raw === 'true' || raw === 'false') params[key] = raw === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(raw)) params[key] = Number(raw);
    else params[key] = raw;
  }
  return { mode: state.recommendationMode, model, params };
}

function recommendationSummary(recommendation: CreationAssetRecommendation): string {
  const params = Object.entries(recommendation.params).map(([key, value]) => `${key}=${String(value)}`);
  return [recommendation.model, ...params].join(' · ');
}

function mediaEditorSignature(state: Pick<MediaEditorState, 'title' | 'tags'>): string {
  return JSON.stringify({ title: state.title, tags: state.tags });
}

function defaultPromptTitle(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 24) || '未命名提示词';
}

function defaultMediaTitle(request: Extract<CreationAssetSaveRequest, { kind: 'media' }>): string {
  return request.file?.name.replace(/\.[^.]+$/, '') || request.sourcePath?.split('/').pop()?.replace(/\.[^.]+$/, '') || '未命名媒体';
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(/[，,]/).map(tag => tag.trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
