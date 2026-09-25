import { useCallback, useRef, useState, type ChangeEvent } from 'react';

import {
  DuplicateCreationAssetError,
  createPromptCreationAsset,
  listCreationAssets,
  saveGenerationFromCanvas,
  saveGenerationFromJob,
  saveMediaCreationAssetFromPath,
  updateMediaCreationAsset,
  updatePromptCreationAsset,
  uploadMediaCreationAsset,
} from '@/api/creationAssets';
import { assetMediaSrc } from '@/components/assets/CreationAssetCards';
import {
  defaultMediaTitle,
  defaultPromptTitle,
  mediaEditorSignature,
  promptEditorSignature,
  type MediaEditorState,
  type PromptEditorState,
} from '@/components/assets/CreationAssetEditors';
import { errorMessage, type CreationAssetSaveRequest, type CreationGenerationSource } from '@/components/assets/creationAssetPanelModel';
import { parseTags } from '@/components/assets/TagField';
import {
  addPromptVariableRange,
  promptTemplateFromSegments,
  segmentsFromPromptTemplate,
  updatePromptVariableRanges,
} from '@/lib/promptAssetTemplate';
import { renderCreationPrompt, type CreationAsset } from '@/schema/creationAssets';

/**
 * 提示词 / 媒体编辑器的草稿、变量选区、重复提示与保存。
 *
 * 忙碌态、错误行、资产列表与选中项归面板：保存成功后由 onSaved 让面板刷新列表并决定落点。
 */
export function useCreationAssetEditor({ projectId, scope, assets, setBusy, setError, onSaved }: {
  projectId?: string;
  scope: 'all' | 'project';
  assets: CreationAsset[];
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  onSaved: (saved: CreationAsset, addToCanvas: boolean) => Promise<void>;
}) {
  const [promptEditor, setPromptEditor] = useState<PromptEditorState | null>(null);
  const [mediaEditor, setMediaEditor] = useState<MediaEditorState | null>(null);
  const [variableName, setVariableName] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [duplicatePromptTitle, setDuplicatePromptTitle] = useState<string | null>(null);
  const [duplicateMediaAssetId, setDuplicateMediaAssetId] = useState<string | null>(null);
  const [addToCanvasAfterSave, setAddToCanvasAfterSave] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const editorDirty = promptEditor
    ? promptEditor.initialSignature !== promptEditorSignature(promptEditor)
    : mediaEditor
      ? mediaEditor.initialSignature !== mediaEditorSignature(mediaEditor) || Boolean(mediaEditor.file)
      : false;

  // 只用 state setter，引用稳定：面板在 saveRequest effect 里调用它，不能让 effect 每次渲染都重跑。
  const loadSaveRequest = useCallback((saveRequest: CreationAssetSaveRequest) => {
    setDuplicatePromptTitle(null);
    setDuplicateMediaAssetId(null);
    if (saveRequest.kind === 'prompt') {
      const template = promptTemplateFromSegments(saveRequest.segments);
      const draft = {
        title: saveRequest.title?.trim() || defaultPromptTitle(template.text),
        text: template.text,
        variables: template.variables,
        tags: '',
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
        mediaKind: saveRequest.mediaKind,
        projectId: saveRequest.projectId,
        source: saveRequest.source,
      };
      setMediaEditor({ ...draft, initialSignature: mediaEditorSignature(draft) });
      setPromptEditor(null);
    }
  }, []);

  // 与 clearEditor 不同：只关两份编辑器，选区与重复提示保留——openAsset 历来如此，别合并。
  function closeEditors() {
    setPromptEditor(null);
    setMediaEditor(null);
  }

  function clearEditor() {
    setPromptEditor(null);
    setMediaEditor(null);
    setSelection(null);
    setVariableName('');
    setDuplicatePromptTitle(null);
    setDuplicateMediaAssetId(null);
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
    };
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
      previewUrl: assetMediaSrc(asset.asset_id, asset.content),
      mediaKind: asset.content.mime_type.startsWith('video/') ? 'video' as const : 'image' as const,
    };
    setPromptEditor(null);
    setMediaEditor({ ...draft, initialSignature: mediaEditorSignature(draft) });
  }

  async function finishSave(saved: CreationAsset, addToCanvas: boolean) {
    clearEditor();
    await onSaved(saved, addToCanvas);
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
      } else if (mediaEditor.source) {
        saved = await saveGenerationAsset(mediaEditor.source, common, mediaEditor.projectId ?? projectId);
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

  return {
    promptEditor,
    mediaEditor,
    editorDirty,
    textareaRef,
    variableName,
    selection,
    duplicatePromptTitle,
    duplicateMediaAssetId,
    addToCanvasAfterSave,
    updatePromptDraft: (next: PromptEditorState) => { setPromptEditor(next); setDuplicatePromptTitle(null); },
    updateMediaDraft: setMediaEditor,
    setVariableName,
    cancelDuplicatePrompt: () => setDuplicatePromptTitle(null),
    cancelDuplicateMedia: () => setDuplicateMediaAssetId(null),
    loadSaveRequest,
    closeEditors,
    clearEditor,
    beginPromptEdit,
    beginMediaEdit,
    savePrompt,
    saveMedia,
    captureSelection,
    addVariable,
    changePromptText,
  };
}

function saveGenerationAsset(
  source: CreationGenerationSource,
  common: { title: string; tags: string[] },
  projectId?: string,
): Promise<CreationAsset> {
  if (source.kind === 'job_output') {
    return saveGenerationFromJob({ job_id: source.job_id, output_index: source.output_index, ...common, project_id: projectId ?? null });
  }
  return saveGenerationFromCanvas({ canvas_project_id: source.canvas_project_id, node_id: source.node_id, version_id: source.version_id, ...common });
}
