import {
  Archive,
  ChevronLeft,
  Clock3,
  ExternalLink,
  FileImage,
  FileText,
  FolderMinus,
  History,
  ImagePlus,
  MoreHorizontal,
  Plus,
  Search,
  Tags,
  Undo2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import {
  DuplicateCreationAssetError,
  archiveCreationAsset,
  createImageCreationAssetVersion,
  createPromptCreationAsset,
  createPromptCreationAssetVersion,
  creationAssetImageUrl,
  listCreationAssets,
  markCreationAssetUsed,
  removeCreationAssetFromProject,
  restoreCreationAsset,
  restoreCreationAssetVersion,
  saveImageCreationAssetFromPath,
  updateCreationAssetMetadata,
  uploadImageCreationAsset,
} from '@/api/creationAssets';
import { Button } from '@/components/ui/button';
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
  latestCreationAssetVersion,
  renderCreationPrompt,
  type CreationAsset,
  type CreationAssetKind,
  type CreationImageAssetVersion,
  type CreationPromptAssetVersion,
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
    kind: 'image';
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
  activeReference?: { assetId: string; versionId: string } | null;
  initialKind?: CreationAssetKind;
  saveRequest?: CreationAssetSaveRequest | null;
  onSaveRequestHandled?: (requestId: string) => void;
  onClose: () => void;
  onUsePrompt: (
    asset: CreationAsset,
    renderedPrompt: string,
    variableValues: Record<string, string>,
    mode: 'replace' | 'insert',
  ) => void;
  onUseImage: (asset: CreationAsset, version: CreationImageAssetVersion) => void;
  onUpdateReference?: (asset: CreationAsset, scope: 'current' | 'all') => Promise<void>;
}

type PromptEditorState = {
  assetId?: string;
  originalSegments?: CreationPromptSegment[];
  title: string;
  text: string;
  variables: PromptVariableRange[];
  tags: string;
};

type ImageEditorState = {
  title: string;
  tags: string;
  request: Extract<CreationAssetSaveRequest, { kind: 'image' }>;
};

type MetadataEditorState = { assetId: string; title: string; tags: string };

export function CreationAssetPanel({
  className,
  projectId,
  canvasTargets = [],
  activeReference,
  initialKind = 'prompt',
  saveRequest,
  onSaveRequestHandled,
  onClose,
  onUsePrompt,
  onUseImage,
  onUpdateReference,
}: CreationAssetPanelProps) {
  const [kind, setKind] = useState<CreationAssetKind>(initialKind);
  const [scope, setScope] = useState<'all' | 'project'>(projectId ? 'project' : 'all');
  const [archived, setArchived] = useState(false);
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [recentTags, setRecentTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promptEditor, setPromptEditor] = useState<PromptEditorState | null>(null);
  const [imageEditor, setImageEditor] = useState<ImageEditorState | null>(null);
  const [metadataEditor, setMetadataEditor] = useState<MetadataEditorState | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [variableName, setVariableName] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [duplicatePromptId, setDuplicatePromptId] = useState<string | null>(null);
  const [duplicateImageAssetId, setDuplicateImageAssetId] = useState<string | null>(null);
  const [addToCanvasAfterSave, setAddToCanvasAfterSave] = useState(false);
  const [canvasPickerAsset, setCanvasPickerAsset] = useState<CreationAsset | null>(null);
  const [linkedCanvas, setLinkedCanvas] = useState<{ projectId: string; name: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selected = assets.find(asset => asset.asset_id === selectedId) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAssets = useMemo(() => assets.filter(asset => {
    if (!normalizedQuery) return true;
    const version = latestCreationAssetVersion(asset);
    const preview = version.kind === 'prompt' ? renderCreationPrompt(version.segments) : version.filename;
    return asset.title.toLocaleLowerCase().includes(normalizedQuery)
      || preview.toLocaleLowerCase().includes(normalizedQuery)
      || asset.tags.some(tag => tag.toLocaleLowerCase().includes(normalizedQuery));
  }), [assets, normalizedQuery]);

  async function refresh() {
    try {
      setError(null);
      const response = await listCreationAssets({
        kind,
        scope: projectId ? scope : 'all',
        projectId,
        archived,
      });
      setAssets(response.assets);
      setRecentTags(response.recent_tags);
      setSelectedId(current => response.assets.some(asset => asset.asset_id === current) ? current : null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  useEffect(() => {
    void refresh();
  }, [archived, kind, projectId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setKind(initialKind);
  }, [initialKind]);

  useEffect(() => {
    if (!saveRequest) return;
    setKind(saveRequest.kind);
    setSelectedId(null);
    setMetadataEditor(null);
    setCanvasPickerAsset(null);
    setLinkedCanvas(null);
    setDuplicatePromptId(null);
    setDuplicateImageAssetId(null);
    setError(null);
    if (saveRequest.kind === 'prompt') {
      const template = promptTemplateFromSegments(saveRequest.segments);
      setPromptEditor({
        title: saveRequest.title?.trim() || defaultPromptTitle(template.text),
        text: template.text,
        variables: template.variables,
        tags: '',
      });
      setImageEditor(null);
    } else {
      setPromptEditor(null);
      setImageEditor({
        title: saveRequest.title?.trim() || defaultImageTitle(saveRequest),
        tags: '',
        request: saveRequest,
      });
    }
    onSaveRequestHandled?.(saveRequest.requestId);
  }, [onSaveRequestHandled, saveRequest]);

  function openAsset(asset: CreationAsset) {
    setSelectedId(asset.asset_id);
    setPromptEditor(null);
    setImageEditor(null);
    setMetadataEditor(null);
    setVariableValues({});
    setShowMenu(false);
    setShowVersions(false);
    setCanvasPickerAsset(null);
    setLinkedCanvas(null);
    setDuplicatePromptId(null);
    setDuplicateImageAssetId(null);
  }

  async function applyAsset(
    asset: CreationAsset,
    mode: 'replace' | 'insert' = 'replace',
    values: Record<string, string> = variableValues,
  ) {
    setBusy(true);
    setError(null);
    try {
      const updated = await markCreationAssetUsed(asset.asset_id, projectId);
      const version = latestCreationAssetVersion(updated);
      if (version.kind === 'prompt') {
        onUsePrompt(updated, renderCreationPrompt(version.segments, values), values, mode);
      } else {
        onUseImage(updated, version);
      }
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function beginPromptEdit(asset?: CreationAsset) {
    const version = asset ? latestCreationAssetVersion(asset) : null;
    const template = version?.kind === 'prompt'
      ? promptTemplateFromSegments(version.segments)
      : { text: '', variables: [] };
    setSelectedId(null);
    setImageEditor(null);
    setMetadataEditor(null);
    setPromptEditor({
      assetId: asset?.asset_id,
      originalSegments: version?.kind === 'prompt' ? version.segments : undefined,
      title: asset?.title ?? '',
      text: template.text,
      variables: template.variables,
      tags: asset?.tags.join(', ') ?? '',
    });
    setSelection(null);
    setVariableName('');
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
        const duplicate = assets.find(asset => {
          const version = latestCreationAssetVersion(asset);
          return version.kind === 'prompt'
            && renderCreationPrompt(version.segments) === renderCreationPrompt(segments);
        });
        if (duplicate) {
          setDuplicatePromptId(duplicate.asset_id);
          setAddToCanvasAfterSave(addToCanvas);
          return;
        }
      }
      let saved: CreationAsset;
      if (promptEditor.assetId) {
        saved = await updateCreationAssetMetadata(promptEditor.assetId, {
          title: promptEditor.title.trim(),
          tags: parseTags(promptEditor.tags),
        });
        if (JSON.stringify(segments) !== JSON.stringify(promptEditor.originalSegments ?? [])) {
          saved = await createPromptCreationAssetVersion(promptEditor.assetId, segments);
        }
      } else {
        saved = await createPromptCreationAsset({
          title: promptEditor.title.trim(),
          segments,
          tags: parseTags(promptEditor.tags),
          projectId,
        });
      }
      setDuplicatePromptId(null);
      await finishSave(saved, addToCanvas);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveImage(addToCanvas = false, allowExisting = false) {
    if (!imageEditor?.title.trim()) {
      setError('图片资产标题不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const common = {
        title: imageEditor.title.trim(),
        tags: parseTags(imageEditor.tags),
        projectId: imageEditor.request.projectId ?? projectId,
      };
      let saved: CreationAsset;
      if (imageEditor.request.file) {
        saved = await uploadImageCreationAsset({
          ...common,
          file: imageEditor.request.file,
          allowExisting,
        });
      } else if (imageEditor.request.sourcePath) {
        saved = await saveImageCreationAssetFromPath({
          ...common,
          sourcePath: imageEditor.request.sourcePath,
          allowExisting,
        });
      } else {
        throw new Error('没有可保存的图片文件。');
      }
      setDuplicateImageAssetId(null);
      await finishSave(saved, addToCanvas);
    } catch (caught) {
      if (caught instanceof DuplicateCreationAssetError) {
        setDuplicateImageAssetId(caught.assetId);
        setAddToCanvasAfterSave(addToCanvas);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function finishSave(saved: CreationAsset, addToCanvas: boolean) {
    setPromptEditor(null);
    setImageEditor(null);
    setMetadataEditor(null);
    await refresh();
    if (addToCanvas && canvasTargets.length > 0) {
      setSelectedId(null);
      setCanvasPickerAsset(saved);
      setLinkedCanvas(null);
    } else {
      setSelectedId(saved.asset_id);
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

  async function removeFromProject(asset: CreationAsset) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await removeCreationAssetFromProject(asset.asset_id, projectId);
      setSelectedId(null);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveMetadata() {
    if (!metadataEditor?.title.trim()) {
      setError('资产标题不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await updateCreationAssetMetadata(metadataEditor.assetId, {
        title: metadataEditor.title.trim(),
        tags: parseTags(metadataEditor.tags),
      });
      setMetadataEditor(null);
      await refresh();
      setSelectedId(saved.asset_id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function replaceImageVersion(asset: CreationAsset, file: File) {
    setBusy(true);
    setError(null);
    try {
      const saved = await createImageCreationAssetVersion(asset.asset_id, file);
      await refresh();
      setSelectedId(saved.asset_id);
    } catch (caught) {
      setError(caught instanceof DuplicateCreationAssetError
        ? '这张图片已经属于另一个资产，请直接使用原资产。'
        : errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive(asset: CreationAsset) {
    setBusy(true);
    setError(null);
    try {
      if (asset.archived_at) await restoreCreationAsset(asset.asset_id);
      else await archiveCreationAsset(asset.asset_id);
      setSelectedId(null);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restoreVersion(asset: CreationAsset, versionId: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await restoreCreationAssetVersion(asset.asset_id, versionId);
      await refresh();
      setSelectedId(updated.asset_id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateReference(asset: CreationAsset, updateScope: 'current' | 'all') {
    if (!onUpdateReference) return;
    setBusy(true);
    setError(null);
    try {
      await onUpdateReference(asset, updateScope);
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
    const next = addPromptVariableRange(promptEditor.variables, {
      name: variableName,
      start: selection.start,
      end: selection.end,
    });
    setPromptEditor({ ...promptEditor, variables: next });
    setVariableName('');
    setSelection(null);
    setDuplicatePromptId(null);
    textareaRef.current?.focus();
  }

  function changePromptText(event: ChangeEvent<HTMLTextAreaElement>) {
    if (!promptEditor) return;
    const nextText = event.target.value;
    setDuplicatePromptId(null);
    setPromptEditor({
      ...promptEditor,
      text: nextText,
      variables: updatePromptVariableRanges(promptEditor.text, nextText, promptEditor.variables),
    });
  }

  const isEditing = Boolean(promptEditor || imageEditor || metadataEditor || canvasPickerAsset);
  return (
    <aside
      aria-label="创作资产"
      className={cn('fixed bottom-56 right-4 top-24 z-40 flex w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover shell-glow', className)}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {(selected || isEditing) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="返回资产列表"
              onClick={() => {
                setSelectedId(null);
                setPromptEditor(null);
                setImageEditor(null);
                setMetadataEditor(null);
                setCanvasPickerAsset(null);
                setLinkedCanvas(null);
                setError(null);
              }}
            >
              <ChevronLeft />
            </Button>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{canvasPickerAsset ? '加入画布' : isEditing ? '保存为创作资产' : selected?.title ?? '创作资产'}</p>
            <p className="text-xs text-muted-foreground">创作台与画布共用</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!selected && !isEditing && (
            <div className="relative">
              <Button variant="ghost" size="icon" aria-label="资产库菜单" onClick={() => setShowMenu(value => !value)}>
                <MoreHorizontal />
              </Button>
              {showMenu && (
                <div className="absolute right-0 top-full z-10 mt-1 min-w-32 rounded-md border border-border bg-popover p-1 shell-glow">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    onClick={() => { setArchived(value => !value); setShowMenu(false); }}
                  >
                    <Archive className="size-3.5" />{archived ? '返回资产库' : '查看归档'}
                  </button>
                </div>
              )}
            </div>
          )}
          <Button variant="ghost" size="icon" aria-label="关闭创作资产" onClick={onClose}><X /></Button>
        </div>
      </header>

      {error && <p role="alert" className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      {!selected && !isEditing && (
        <>
          <div className="grid grid-cols-2 border-b border-border p-1.5" role="group" aria-label="资产类型">
            <PanelTab active={kind === 'prompt'} onClick={() => setKind('prompt')}><FileText />提示词</PanelTab>
            <PanelTab active={kind === 'image'} onClick={() => setKind('image')}><FileImage />图片</PanelTab>
          </div>
          <div className="space-y-2 border-b border-border p-3">
            {projectId && (
              <div className="flex gap-1" role="group" aria-label="资产范围">
                <ScopeButton active={scope === 'all'} onClick={() => setScope('all')}>全部资产</ScopeButton>
                <ScopeButton active={scope === 'project'} onClick={() => setScope('project')}>本项目</ScopeButton>
              </div>
            )}
            <label className="relative block">
              <span className="sr-only">搜索创作资产</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、正文或标签" className="pl-9" />
            </label>
            {kind === 'prompt' && !archived && (
              <Button variant="outline" size="sm" className="w-full" onClick={() => beginPromptEdit()}><Plus />新建提示词资产</Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {visibleAssets.length ? visibleAssets.map(asset => (
              <AssetCard
                key={asset.asset_id}
                asset={asset}
                busy={busy}
                hasNewerReference={activeReference?.assetId === asset.asset_id && activeReference.versionId !== asset.latest_version_id}
                onOpen={() => openAsset(asset)}
                onUse={() => void applyAsset(asset, 'replace', {})}
              />
            )) : (
              <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-border px-8 text-center text-xs leading-relaxed text-muted-foreground">
                {normalizedQuery ? '没有匹配的创作资产' : archived ? '归档中没有资产' : kind === 'prompt' ? '还没有提示词资产' : '还没有图片资产'}
              </div>
            )}
          </div>
        </>
      )}

      {promptEditor && (
        <PromptEditor
          state={promptEditor}
          busy={busy}
          recentTags={recentTags}
          textareaRef={textareaRef}
          variableName={variableName}
          selection={selection}
          duplicateTitle={assets.find(asset => asset.asset_id === duplicatePromptId)?.title}
          showSaveAndAddCanvas={canvasTargets.length > 0 && !promptEditor.assetId}
          onChange={(next) => { setPromptEditor(next); setDuplicatePromptId(null); }}
          onTextChange={changePromptText}
          onCaptureSelection={captureSelection}
          onVariableNameChange={setVariableName}
          onAddVariable={addVariable}
          onSave={() => void savePrompt(false)}
          onSaveAndAddCanvas={() => void savePrompt(true)}
          onConfirmDuplicate={() => void savePrompt(addToCanvasAfterSave, true)}
          onCancelDuplicate={() => setDuplicatePromptId(null)}
        />
      )}

      {imageEditor && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {imageEditor.request.file && <ObjectUrlImage file={imageEditor.request.file} />}
          {(imageEditor.request.previewUrl || imageEditor.request.sourcePath) && (
            <img src={imageEditor.request.previewUrl || imageEditor.request.sourcePath} alt="待保存图片预览" className="aspect-square w-full rounded-lg border border-border object-contain" />
          )}
          <Field label="标题"><Input value={imageEditor.title} onChange={event => setImageEditor({ ...imageEditor, title: event.target.value })} /></Field>
          <TagField value={imageEditor.tags} recentTags={recentTags} onChange={tags => setImageEditor({ ...imageEditor, tags })} />
          {duplicateImageAssetId && (
            <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed">
              <p>这张图片已经在资产库中。可以直接复用原资产，不会创建重复副本。</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDuplicateImageAssetId(null)}>取消</Button>
                <Button size="sm" disabled={busy} onClick={() => void saveImage(addToCanvasAfterSave, true)}>复用原资产</Button>
              </div>
            </div>
          )}
          {!duplicateImageAssetId && (
            <div className="grid gap-2">
              <Button className="w-full" disabled={busy} onClick={() => void saveImage(false)}>{busy ? '保存中…' : '保存图片资产'}</Button>
              {canvasTargets.length > 0 && <Button variant="outline" className="w-full" disabled={busy} onClick={() => void saveImage(true)}>保存并加入画布</Button>}
            </div>
          )}
        </div>
      )}

      {canvasPickerAsset && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-sm font-medium">{canvasPickerAsset.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">选择一个画布，资产会出现在该画布的“本项目”范围中。</p>
          </div>
          {!linkedCanvas && canvasTargets.map(target => (
            <button
              key={target.projectId}
              type="button"
              disabled={busy}
              className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-3 text-left text-sm hover:bg-secondary disabled:opacity-50"
              onClick={() => void connectToCanvas(target)}
            >
              <span className="truncate">{target.name}</span>
              <span className="text-xs text-muted-foreground">加入</span>
            </button>
          ))}
          {linkedCanvas && (
            <div role="status" className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs">
              已加入“{linkedCanvas.name}”。
              <a className="ml-1 inline-flex items-center gap-1 text-primary hover:underline" href={`/canvas/${encodeURIComponent(linkedCanvas.projectId)}`}>
                打开画布<ExternalLink className="size-3" />
              </a>
            </div>
          )}
        </div>
      )}

      {metadataEditor && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <Field label="标题"><Input value={metadataEditor.title} onChange={event => setMetadataEditor({ ...metadataEditor, title: event.target.value })} /></Field>
          <TagField value={metadataEditor.tags} recentTags={recentTags} onChange={tags => setMetadataEditor({ ...metadataEditor, tags })} />
          <Button className="w-full" disabled={busy} onClick={() => void saveMetadata()}>{busy ? '保存中…' : '保存信息'}</Button>
        </div>
      )}

      {selected && (
        <AssetDetail
          asset={selected}
          busy={busy}
          hasNewerReference={activeReference?.assetId === selected.asset_id && activeReference.versionId !== selected.latest_version_id}
          values={variableValues}
          showVersions={showVersions}
          onValuesChange={setVariableValues}
          onUse={mode => void applyAsset(selected, mode)}
          onEdit={() => beginPromptEdit(selected)}
          onEditMetadata={() => {
            setSelectedId(null);
            setMetadataEditor({ assetId: selected.asset_id, title: selected.title, tags: selected.tags.join(', ') });
          }}
          onReplaceImage={file => void replaceImageVersion(selected, file)}
          canRemoveFromProject={Boolean(projectId && selected.project_ids.includes(projectId))}
          onRemoveFromProject={() => void removeFromProject(selected)}
          onUpdateReference={onUpdateReference ? scope => void updateReference(selected, scope) : undefined}
          onArchive={() => void toggleArchive(selected)}
          onToggleVersions={() => setShowVersions(value => !value)}
          onRestoreVersion={versionId => void restoreVersion(selected, versionId)}
        />
      )}
    </aside>
  );
}

function AssetCard({ asset, busy, hasNewerReference, onOpen, onUse }: {
  asset: CreationAsset;
  busy: boolean;
  hasNewerReference: boolean;
  onOpen: () => void;
  onUse: () => void;
}) {
  const version = latestCreationAssetVersion(asset);
  return (
    <article className="mb-2 rounded-lg border border-border bg-card p-3">
      <button type="button" className="w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={onOpen}>
        {version.kind === 'image' && (
          <img src={creationAssetImageUrl(asset.asset_id, version.version_id)} alt="" loading="lazy" className="mb-3 aspect-[4/3] w-full rounded-md bg-secondary object-cover" />
        )}
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{asset.title}</p>
          {hasNewerReference && <span className="shrink-0 rounded-full border border-primary/40 px-2 py-0.5 text-xs text-primary">有新版本</span>}
        </div>
        {version.kind === 'prompt' ? (
          <PromptPreview segments={version.segments} />
        ) : (
          <p className="mt-1 truncate text-xs text-muted-foreground">{version.filename}</p>
        )}
        <TagList tags={asset.tags} />
      </button>
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={busy} onClick={onUse}>使用</Button>
      </div>
    </article>
  );
}

function ObjectUrlImage({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <img src={url} alt="待保存图片预览" className="aspect-square w-full rounded-lg border border-border object-contain" /> : null;
}

function PromptPreview({ segments }: { segments: CreationPromptSegment[] }) {
  return (
    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
      {segments.map((segment, index) => segment.kind === 'text' ? segment.text : (
        <span key={`${segment.name}-${index}`} className="mx-0.5 rounded border border-border bg-secondary px-1">
          <span className="text-muted-foreground">{segment.name}：</span>
          <span className="text-foreground/80">{segment.default_value}</span>
        </span>
      ))}
    </p>
  );
}

function PromptEditor({
  state,
  busy,
  recentTags,
  textareaRef,
  variableName,
  selection,
  duplicateTitle,
  showSaveAndAddCanvas,
  onChange,
  onTextChange,
  onCaptureSelection,
  onVariableNameChange,
  onAddVariable,
  onSave,
  onSaveAndAddCanvas,
  onConfirmDuplicate,
  onCancelDuplicate,
}: {
  state: PromptEditorState;
  busy: boolean;
  recentTags: string[];
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
}) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <Field label="标题"><Input value={state.title} onChange={event => onChange({ ...state, title: event.target.value })} placeholder="给这条提示词起个名字" /></Field>
      <Field label="提示词正文">
        <textarea
          ref={textareaRef}
          rows={9}
          value={state.text}
          onChange={onTextChange}
          onSelect={onCaptureSelection}
          placeholder="输入可复用的提示词正文"
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
      </Field>
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="text-sm font-medium">变量</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">选中正文中的内容，输入变量名。选中文字就是默认内容。</p>
        <div className="mt-3 flex gap-2">
          <Input value={variableName} onChange={event => onVariableNameChange(event.target.value)} placeholder={selection ? '例如：主体' : '先在正文中选中内容'} disabled={!selection} />
          <Button size="sm" disabled={!selection || !variableName.trim()} onClick={onAddVariable}>设为变量</Button>
        </div>
        {state.variables.length > 0 && (
          <div className="mt-3 space-y-2">
            {state.variables.map(variable => (
              <div key={variable.id} className="flex items-center gap-2 rounded-md bg-secondary px-2 py-1.5 text-xs">
                <span className="text-muted-foreground">{variable.name}：</span>
                <span className="min-w-0 flex-1 truncate">{state.text.slice(variable.start, variable.end)}</span>
                <button
                  type="button"
                  aria-label={`移除变量 ${variable.name}`}
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => onChange({ ...state, variables: state.variables.filter(item => item.id !== variable.id) })}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <TagField value={state.tags} recentTags={recentTags} onChange={tags => onChange({ ...state, tags })} />
      {duplicateTitle ? (
        <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed">
          <p>提示词正文与“{duplicateTitle}”相同，仍可按你的意图保存为另一条资产。</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onCancelDuplicate}>取消</Button>
            <Button size="sm" disabled={busy} onClick={onConfirmDuplicate}>仍然保存</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          <Button className="w-full" disabled={busy} onClick={onSave}>{busy ? '保存中…' : state.assetId ? '保存为新版本' : '保存提示词资产'}</Button>
          {showSaveAndAddCanvas && <Button variant="outline" className="w-full" disabled={busy} onClick={onSaveAndAddCanvas}>保存并加入画布</Button>}
        </div>
      )}
    </div>
  );
}

function AssetDetail({
  asset,
  busy,
  hasNewerReference,
  values,
  showVersions,
  onValuesChange,
  onUse,
  onEdit,
  onEditMetadata,
  onReplaceImage,
  canRemoveFromProject,
  onRemoveFromProject,
  onUpdateReference,
  onArchive,
  onToggleVersions,
  onRestoreVersion,
}: {
  asset: CreationAsset;
  busy: boolean;
  hasNewerReference: boolean;
  values: Record<string, string>;
  showVersions: boolean;
  onValuesChange: (values: Record<string, string>) => void;
  onUse: (mode: 'replace' | 'insert') => void;
  onEdit: () => void;
  onEditMetadata: () => void;
  onReplaceImage: (file: File) => void;
  canRemoveFromProject: boolean;
  onRemoveFromProject: () => void;
  onUpdateReference?: (scope: 'current' | 'all') => void;
  onArchive: () => void;
  onToggleVersions: () => void;
  onRestoreVersion: (versionId: string) => void;
}) {
  const version = latestCreationAssetVersion(asset);
  const variables = version.kind === 'prompt'
    ? uniquePromptVariables(version)
    : [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {version.kind === 'image' && (
        <img src={creationAssetImageUrl(asset.asset_id, version.version_id)} alt={asset.title} className="aspect-square w-full rounded-lg border border-border bg-secondary object-contain" />
      )}
      <h2 className="mt-3 text-base font-medium">{asset.title}</h2>
      {version.kind === 'prompt' && <PromptPreview segments={version.segments} />}
      <TagList tags={asset.tags} />

      {version.kind === 'prompt' && variables.length > 0 && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-card p-3">
          <div>
            <p className="text-sm font-medium">填写变量</p>
            <p className="mt-1 text-xs text-muted-foreground">不填写时使用模板中的默认内容。</p>
          </div>
          {variables.map(variable => (
            <Field key={variable.name} label={variable.name} hint={`默认：${variable.defaultValue}`}>
              <Input
                value={values[variable.name] ?? ''}
                onChange={event => onValuesChange({ ...values, [variable.name]: event.target.value })}
                placeholder={variable.defaultValue}
              />
            </Field>
          ))}
        </div>
      )}

      {hasNewerReference && onUpdateReference && (
        <div className="mt-4 rounded-lg border border-primary/40 bg-primary/10 p-3">
          <p className="text-xs font-medium text-primary">当前引用有新版本</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">不会自动替换。更新提示词时会保留同名变量的当前填写值。</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => onUpdateReference('current')}>更新当前引用</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onUpdateReference('all')}>更新本画布全部</Button>
          </div>
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button className="flex-1" disabled={busy} onClick={() => onUse('replace')}>使用</Button>
        {version.kind === 'prompt' && <Button variant="outline" disabled={busy} onClick={() => onUse('insert')}>插入光标</Button>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {version.kind === 'prompt' && !asset.archived_at && <Button variant="ghost" size="sm" onClick={onEdit}><FileText />编辑新版本</Button>}
        {version.kind === 'image' && !asset.archived_at && (
          <label className="inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md px-3 text-xs font-medium hover:bg-glass hover:text-accent-foreground focus-within:ring-1 focus-within:ring-primary">
            <ImagePlus className="size-4" />替换图片
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" disabled={busy} onChange={event => {
              const file = event.target.files?.[0];
              if (file) onReplaceImage(file);
              event.target.value = '';
            }} />
          </label>
        )}
        <Button variant="ghost" size="sm" onClick={onEditMetadata}><Tags />编辑信息</Button>
        <Button variant="ghost" size="sm" onClick={onToggleVersions}><History />版本 {asset.versions.length}</Button>
        {canRemoveFromProject && <Button variant="ghost" size="sm" disabled={busy} onClick={onRemoveFromProject}><FolderMinus />移出本项目</Button>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onArchive}>{asset.archived_at ? <Undo2 /> : <Archive />}{asset.archived_at ? '恢复' : '归档'}</Button>
      </div>

      {showVersions && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {[...asset.versions].reverse().map((item, index) => (
            <div key={item.version_id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">{index === 0 ? '当前版本' : `历史版本 ${asset.versions.length - index}`}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground"><Clock3 className="mr-1 inline size-3" />{formatDate(item.created_at)}</p>
              </div>
              {item.version_id !== asset.latest_version_id && <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRestoreVersion(item.version_id)}>恢复为新版本</Button>}
            </div>
          ))}
        </div>
      )}
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

function TagField({ value, recentTags, onChange }: { value: string; recentTags: string[]; onChange: (value: string) => void }) {
  const current = new Set(parseTags(value));
  const [draft, setDraft] = useState('');
  const commitDraft = () => {
    const additions = parseTags(draft);
    if (!additions.length) return;
    onChange([...parseTags(value), ...additions].join(', '));
    setDraft('');
  };
  return (
    <Field label="标签">
      <div className="relative">
        <Tags className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ',') return;
            event.preventDefault();
            commitDraft();
          }}
          placeholder="输入标签，按 Enter 添加"
          className="pl-9"
        />
      </div>
      {current.size > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {[...current].map(tag => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
              {tag}
              <button type="button" aria-label={`移除标签 ${tag}`} onClick={() => onChange(parseTags(value).filter(item => item !== tag).join(', '))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {recentTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {recentTags.slice(0, 8).map(tag => (
            <button key={tag} type="button" className={cn('rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground', current.has(tag) && 'bg-secondary text-foreground')} onClick={() => {
              const tags = parseTags(value);
              onChange(current.has(tag) ? tags.filter(item => item !== tag).join(', ') : [...tags, tag].join(', '));
            }}>{tag}</button>
          ))}
        </div>
      )}
    </Field>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5">{tags.map(tag => <span key={tag} className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{tag}</span>)}</div>;
}

function uniquePromptVariables(version: CreationPromptAssetVersion): { name: string; defaultValue: string }[] {
  const result = new Map<string, string>();
  version.segments.forEach(segment => {
    if (segment.kind === 'variable' && !result.has(segment.name)) result.set(segment.name, segment.default_value);
  });
  return [...result].map(([name, defaultValue]) => ({ name, defaultValue }));
}

function defaultPromptTitle(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 24) || '未命名提示词';
}

function defaultImageTitle(request: Extract<CreationAssetSaveRequest, { kind: 'image' }>): string {
  return request.file?.name.replace(/\.[^.]+$/, '') || request.sourcePath?.split('/').pop()?.replace(/\.[^.]+$/, '') || '未命名图片';
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(/[，,]/).map(tag => tag.trim()).filter(Boolean))];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
