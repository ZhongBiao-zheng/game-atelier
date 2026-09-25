import { FileImage, X } from 'lucide-react';
import type { ChangeEvent } from 'react';

import { DeleteAssetButton, PathPreview, PendingFilePreview, isVideoSourcePath } from '@/components/assets/CreationAssetCards';
import { Field } from '@/components/assets/CreationAssetPanelBits';
import { TagField } from '@/components/assets/TagField';
import type { CreationAssetSaveRequest, CreationGenerationSource, CreationMediaKind } from '@/components/assets/creationAssetPanelModel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PromptVariableRange } from '@/lib/promptAssetTemplate';

export type PromptEditorState = {
  assetId?: string;
  title: string;
  text: string;
  variables: PromptVariableRange[];
  tags: string;
  initialSignature: string;
};

export type MediaEditorState = {
  assetId?: string;
  title: string;
  tags: string;
  file?: File;
  sourcePath?: string;
  previewUrl?: string;
  mediaKind?: CreationMediaKind;
  projectId?: string;
  source?: CreationGenerationSource;
  initialSignature: string;
};

/** 服务端能存的媒体类型（与 schemas.MEDIA_SUFFIXES 一致）。 */
const MEDIA_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4';

export function PromptEditor({ state, busy, textareaRef, variableName, selection, duplicateTitle, showSaveAndAddCanvas, onChange, onTextChange, onCaptureSelection, onVariableNameChange, onAddVariable, onSave, onSaveAndAddCanvas, onConfirmDuplicate, onCancelDuplicate, onDelete }: {
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
      {duplicateTitle ? <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed"><p>提示词正文与“{duplicateTitle}”相同，仍可按你的意图保存为另一条资产。</p><div className="mt-3 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onCancelDuplicate}>取消</Button><Button size="sm" disabled={busy} onClick={onConfirmDuplicate}>仍然保存</Button></div></div> : <div className="grid gap-2"><Button className="w-full" disabled={busy} onClick={onSave}>{busy ? '保存中…' : state.assetId ? '保存修改' : '保存提示词资产'}</Button>{showSaveAndAddCanvas && <Button variant="outline" className="w-full" disabled={busy} onClick={onSaveAndAddCanvas}>保存并加入画布</Button>}</div>}
      {onDelete && <DeleteAssetButton disabled={busy} onClick={onDelete} />}
    </div>
  );
}

export function MediaEditor({ state, busy, duplicateTitle, showSaveAndAddCanvas, onChange, onSave, onSaveAndAddCanvas, onConfirmDuplicate, onCancelDuplicate, onDelete }: {
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
      {state.file ? <PendingFilePreview file={state.file} /> : state.previewUrl || state.sourcePath ? <PathPreview src={state.previewUrl || state.sourcePath || ''} video={state.mediaKind ? state.mediaKind === 'video' : isVideoSourcePath(state.sourcePath)} /> : null}
      {state.assetId && <label className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-secondary focus-within:ring-1 focus-within:ring-primary"><FileImage className="size-4" />{state.file ? '重新选择文件' : '替换文件（可选）'}<input type="file" accept={MEDIA_ACCEPT} className="sr-only" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) onChange({ ...state, file }); event.target.value = ''; }} /></label>}
      <Field label="标题"><Input value={state.title} onChange={event => onChange({ ...state, title: event.target.value })} /></Field>
      <TagField value={state.tags} onChange={tags => onChange({ ...state, tags })} />
      {duplicateTitle ? <div className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed"><p>这个文件已经在资产库的“{duplicateTitle}”中。可以复用原资产，不会创建重复副本。</p><div className="mt-3 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={onCancelDuplicate}>取消</Button>{!state.assetId && <Button size="sm" disabled={busy} onClick={onConfirmDuplicate}>复用原资产</Button>}</div></div> : <div className="grid gap-2"><Button className="w-full" disabled={busy} onClick={onSave}>{busy ? '保存中…' : state.assetId ? '保存修改' : state.source ? '保存生成资产' : '保存媒体资产'}</Button>{showSaveAndAddCanvas && <Button variant="outline" className="w-full" disabled={busy} onClick={onSaveAndAddCanvas}>保存并加入画布</Button>}</div>}
      {onDelete && <DeleteAssetButton disabled={busy} onClick={onDelete} />}
    </div>
  );
}

export function promptEditorSignature(state: Omit<PromptEditorState, 'assetId' | 'initialSignature'>): string {
  const { title, text, variables, tags } = state;
  return JSON.stringify({ title, text, variables, tags });
}

export function mediaEditorSignature(state: Pick<MediaEditorState, 'title' | 'tags'>): string {
  return JSON.stringify({ title: state.title, tags: state.tags });
}

export function defaultPromptTitle(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 24) || '未命名提示词';
}

export function defaultMediaTitle(request: Extract<CreationAssetSaveRequest, { kind: 'media' }>): string {
  return request.file?.name.replace(/\.[^.]+$/, '') || request.sourcePath?.split('/').pop()?.replace(/\.[^.]+$/, '') || '未命名媒体';
}
