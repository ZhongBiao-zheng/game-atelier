import { promptFromAsset } from '@/lib/promptVariables';
import { ChevronLeft, FileImage, FileText, Plus, Search, Users, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { deleteCreationAsset, listCreationAssets, markCreationAssetUsed } from '@/api/creationAssets';
import { AssetCard, AssetDetail } from '@/components/assets/CreationAssetCards';
import { MediaEditor, PromptEditor } from '@/components/assets/CreationAssetEditors';
import { CanvasPicker, DeleteAssetDialog, DiscardChangesDialog, PanelTab, ScopeButton } from '@/components/assets/CreationAssetPanelBits';
import { errorMessage, type CreationAssetPanelMode, type CreationAssetSaveRequest } from '@/components/assets/creationAssetPanelModel';
import { TeamLibraryPanel } from '@/components/assets/TeamLibraryPanel';
import { useAdoptionStaleness } from '@/components/assets/useAdoptionStaleness';
import { useCreationAssetEditor } from '@/components/assets/useCreationAssetEditor';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { assetMediaContent, renderCreationPrompt, type CreationAsset, type CreationMediaAssetContent } from '@/schema/creationAssets';
import type { TeamAssetAdoptResponse, TeamLibraryIndexEntry } from '@/schema/teamLibrary';

export type { CreationAssetPanelMode, CreationAssetSaveRequest, CreationGenerationSource, CreationMediaKind } from '@/components/assets/creationAssetPanelModel';

export interface CreationAssetPanelProps {
  className?: string;
  projectId?: string;
  canvasTargets?: { projectId: string; name: string }[];
  initialKind?: CreationAssetPanelMode;
  saveRequest?: CreationAssetSaveRequest | null;
  onSaveRequestHandled?: (requestId: string) => void;
  onClose: () => void;
  onUsePrompt: (
    asset: CreationAsset,
    renderedPrompt: string,
  ) => void;
  onUseMedia: (asset: CreationAsset, content: CreationMediaAssetContent) => void;
  /** 团队栏「挂载」出口，参数是团队栏当前的画布项目；不给就不显示挂载按钮。 */
  onOpenSettings?: (projectId: string) => void;
  onTeamAssetAdopted?: (result: TeamAssetAdoptResponse, entry: TeamLibraryIndexEntry) => void;
  /** 复刻生成资产（asset.kind 恒为 'generation'）；传了才显示「复刻」。 */
  onReproduce?: (asset: CreationAsset) => void;
  /** 透传给团队栏：有值时「相关配方」按参考 sha256 命中。 */
  teamRelatedSha256?: string | null;
  /** 团队栏初始选中的库；不在当前画布的挂载列表里就忽略。 */
  initialTeamLibraryId?: string | null;
  /** 没有 projectId（Studio）时团队栏初始落在哪个画布；不在 canvasTargets 里就退回第一个。 */
  initialTeamProjectId?: string | null;
}

export interface CreationAssetPanelHandle {
  requestClose: () => void;
  requestTransition: (action: () => void) => void;
}

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
  onOpenSettings,
  onTeamAssetAdopted,
  onReproduce,
  teamRelatedSha256,
  initialTeamLibraryId,
  initialTeamProjectId,
}: CreationAssetPanelProps, ref) {
  const [kind, setKind] = useState<CreationAssetPanelMode>(initialKind);
  const [scope, setScope] = useState<'all' | 'project'>(projectId ? 'project' : 'all');
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canvasPickerAsset, setCanvasPickerAsset] = useState<CreationAsset | null>(null);
  const [linkedCanvas, setLinkedCanvas] = useState<{ projectId: string; name: string } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CreationAsset | null>(null);
  const leaveActionRef = useRef<(() => void) | null>(null);
  const adoption = useAdoptionStaleness({ setAssets, setBusy, setError });
  const editor = useCreationAssetEditor({ projectId, scope, assets, setBusy, setError, onSaved: finishSave });
  const { promptEditor, mediaEditor, editorDirty, clearEditor, loadSaveRequest } = editor;

  const selected = assets.find(asset => asset.asset_id === selectedId) ?? null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAssets = useMemo(() => assets.filter(asset => {
    if (!normalizedQuery) return true;
    const preview = asset.content.kind === 'prompt'
      ? renderCreationPrompt(asset.content.segments)
      : assetMediaContent(asset)?.filename ?? '';
    return asset.title.toLocaleLowerCase().includes(normalizedQuery)
      || preview.toLocaleLowerCase().includes(normalizedQuery)
      || asset.tags.some(tag => tag.toLocaleLowerCase().includes(normalizedQuery));
  }), [assets, normalizedQuery]);

  async function refresh(preferredId?: string) {
    // 团队库是只读的外部挂载，不走本机创作资产目录。
    if (kind === 'team') return;
    try {
      setError(null);
      // 媒体 tab 同时列媒体与生成资产（生成资产按成片渲染），所以不按 kind 过滤、取回后再分。
      const response = await listCreationAssets({
        kind: kind === 'prompt' ? 'prompt' : undefined,
        scope: projectId ? scope : 'all',
        projectId,
      });
      const rows = kind === 'prompt'
        ? response.assets
        : response.assets.filter(asset => assetMediaContent(asset) !== null);
      setAssets(rows);
      setSelectedId(current => {
        const target = preferredId ?? current;
        return rows.some(asset => asset.asset_id === target) ? target : null;
      });
      void adoption.checkStaleness(rows);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  useEffect(() => {
    void refresh();
  }, [kind, projectId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setKind(initialKind), [initialKind]);

  // 团队库挂在画布项目上。画布里固定用当前画布；Studio 没有当前画布，从可连接的画布里选。
  const teamProjectChoices = useMemo(
    () => projectId ? [] : canvasTargets,
    [projectId, canvasTargets],
  );
  const [pickedTeamProjectId, setPickedTeamProjectId] = useState<string | null>(initialTeamProjectId ?? null);
  const teamProjectId = projectId
    ?? teamProjectChoices.find(target => target.projectId === pickedTeamProjectId)?.projectId
    ?? teamProjectChoices[0]?.projectId;

  // 可用的画布项目消失时，团队 tab 和主体会同时消失，用户困在空面板里切不走。
  useEffect(() => {
    if (kind === 'team' && !teamProjectId) setKind('prompt');
  }, [kind, teamProjectId]);

  useEffect(() => {
    if (!saveRequest) return;
    setKind(saveRequest.kind);
    setSelectedId(null);
    setCanvasPickerAsset(null);
    setLinkedCanvas(null);
    setError(null);
    loadSaveRequest(saveRequest);
    onSaveRequestHandled?.(saveRequest.requestId);
  }, [loadSaveRequest, onSaveRequestHandled, saveRequest]);

  function openAsset(asset: CreationAsset) {
    setSelectedId(asset.asset_id);
    editor.closeEditors();
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
      const media = assetMediaContent(updated);
      if (updated.content.kind === 'prompt') {
        onUsePrompt(updated, promptFromAsset(updated.content.segments));
      } else if (media) {
        onUseMedia(updated, media);
      }
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  // 与「使用」同一套路：记一次使用，交给调用方填输入框，然后收起面板。
  async function reproduceAsset(asset: CreationAsset) {
    if (!onReproduce) return;
    setBusy(true);
    setError(null);
    try {
      onReproduce(await markCreationAssetUsed(asset.asset_id, projectId));
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function beginPromptEdit(asset?: CreationAsset) {
    setSelectedId(null);
    editor.beginPromptEdit(asset);
  }

  function beginMediaEdit(asset: CreationAsset) {
    if (asset.content.kind !== 'media') return;
    setSelectedId(null);
    editor.beginMediaEdit(asset);
  }

  // 编辑器已清空后调用：刷新列表，再决定落在资产详情还是「加入画布」。
  async function finishSave(saved: CreationAsset, addToCanvas: boolean) {
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
          <div className={cn('grid border-b border-border p-1.5', teamProjectId ? 'grid-cols-3' : 'grid-cols-2')} role="group" aria-label="资产类型">
            <PanelTab active={kind === 'prompt'} onClick={() => setKind('prompt')}><FileText />提示词</PanelTab>
            <PanelTab active={kind === 'media'} onClick={() => setKind('media')}><FileImage />媒体</PanelTab>
            {teamProjectId && <PanelTab active={kind === 'team'} onClick={() => setKind('team')}><Users />团队</PanelTab>}
          </div>
          {kind === 'team' && teamProjectId && teamProjectChoices.length > 1 && (
            <div className="border-b border-border p-3">
              <select
                aria-label="画布项目"
                value={teamProjectId}
                onChange={event => setPickedTeamProjectId(event.target.value)}
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {teamProjectChoices.map(target => (
                  <option key={target.projectId} value={target.projectId}>{target.name}</option>
                ))}
              </select>
            </div>
          )}
          {kind === 'team' && teamProjectId && (
            <TeamLibraryPanel
              key={teamProjectId}
              projectId={teamProjectId}
              onAdopted={(result, entry) => { void refresh(); onTeamAssetAdopted?.(result, entry); }}
              onOpenSettings={onOpenSettings ? () => onOpenSettings(teamProjectId) : undefined}
              onReproduce={onReproduce ? asset => { onReproduce(asset); onClose(); } : undefined}
              relatedSha256={teamRelatedSha256}
              initialTeamLibraryId={initialTeamLibraryId}
              className="min-h-0 flex-1"
            />
          )}
          {kind !== 'team' && (
          <div className="space-y-2 border-b border-border p-3">
            {projectId && <div className="flex gap-1" role="group" aria-label="资产范围"><ScopeButton active={scope === 'all'} onClick={() => setScope('all')}>全部资产</ScopeButton><ScopeButton active={scope === 'project'} onClick={() => setScope('project')}>本项目</ScopeButton></div>}
            <label className="relative block">
              <span className="sr-only">搜索创作资产</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、正文或标签" className="pl-9" />
            </label>
            {kind === 'prompt' && <Button variant="outline" size="sm" className="w-full" onClick={() => beginPromptEdit()}><Plus />新建提示词资产</Button>}
          </div>
          )}
          {kind !== 'team' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {adoption.stalenessError && <p className="mb-2 text-xs text-muted-foreground">来源状态读取失败</p>}
            {visibleAssets.length ? visibleAssets.map(asset => <AssetCard key={asset.asset_id} asset={asset} busy={busy} staleness={adoption.staleness[asset.asset_id]} onOpen={() => openAsset(asset)} onReproduce={onReproduce && asset.kind === 'generation' ? () => void reproduceAsset(asset) : undefined} onReadopt={() => adoption.requestReadopt(asset)} />) : (
              <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-border px-8 text-center text-xs leading-relaxed text-muted-foreground">{normalizedQuery ? '没有匹配的创作资产' : kind === 'prompt' ? '还没有提示词资产' : '还没有媒体资产'}</div>
            )}
          </div>
          )}
        </>
      )}

      {promptEditor && (
        <PromptEditor
          state={promptEditor}
          busy={busy}
          textareaRef={editor.textareaRef}
          variableName={editor.variableName}
          selection={editor.selection}
          duplicateTitle={editor.duplicatePromptTitle ?? undefined}
          showSaveAndAddCanvas={canvasTargets.length > 0 && !promptEditor.assetId}
          onChange={editor.updatePromptDraft}
          onTextChange={editor.changePromptText}
          onCaptureSelection={editor.captureSelection}
          onVariableNameChange={editor.setVariableName}
          onAddVariable={editor.addVariable}
          onSave={() => void editor.savePrompt(false)}
          onSaveAndAddCanvas={() => void editor.savePrompt(true)}
          onConfirmDuplicate={() => void editor.savePrompt(editor.addToCanvasAfterSave, true)}
          onCancelDuplicate={editor.cancelDuplicatePrompt}
          onDelete={editingAsset ? () => setDeleteTarget(editingAsset) : undefined}
        />
      )}

      {mediaEditor && (
        <MediaEditor
          state={mediaEditor}
          busy={busy}
          duplicateTitle={assets.find(asset => asset.asset_id === editor.duplicateMediaAssetId)?.title}
          showSaveAndAddCanvas={canvasTargets.length > 0 && !mediaEditor.assetId}
          onChange={editor.updateMediaDraft}
          onSave={() => void editor.saveMedia(false)}
          onSaveAndAddCanvas={() => void editor.saveMedia(true)}
          onConfirmDuplicate={() => void editor.saveMedia(editor.addToCanvasAfterSave, true)}
          onCancelDuplicate={editor.cancelDuplicateMedia}
          onDelete={editingAsset ? () => setDeleteTarget(editingAsset) : undefined}
        />
      )}

      {canvasPickerAsset && (
        <CanvasPicker
          asset={canvasPickerAsset}
          targets={canvasTargets}
          linkedCanvas={linkedCanvas}
          busy={busy}
          onConnect={target => void connectToCanvas(target)}
        />
      )}

      {selected && (
        <AssetDetail
          asset={selected}
          busy={busy}
          staleness={adoption.staleness[selected.asset_id]}
          onReadopt={() => adoption.requestReadopt(selected)}
          onUse={() => void applyAsset(selected)}
          onReproduce={onReproduce && selected.kind === 'generation' ? () => void reproduceAsset(selected) : undefined}
          // 生成资产是冻结快照，本机不改；只能删。
          onEdit={selected.kind === 'generation' ? undefined : () => selected.kind === 'prompt' ? beginPromptEdit(selected) : beginMediaEdit(selected)}
          onDelete={selected.kind === 'generation' ? () => setDeleteTarget(selected) : undefined}
        />
      )}

      <ConfirmDialog
        open={Boolean(adoption.readoptTarget)}
        title="覆盖本机副本？"
        message={adoption.readoptTarget?.title ?? ''}
        confirmText="覆盖"
        onConfirm={() => void adoption.confirmReadopt()}
        onCancel={adoption.cancelReadopt}
      />

      <DiscardChangesDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        onKeepEditing={() => setDiscardOpen(false)}
        onDiscard={() => { setDiscardOpen(false); const action = leaveActionRef.current; leaveActionRef.current = null; action?.(); }}
      />

      <DeleteAssetDialog
        target={deleteTarget}
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </aside>
  );
});
