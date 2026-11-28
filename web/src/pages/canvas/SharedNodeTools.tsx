import { CanvasInpaintEditor } from '@/components/canvas/CanvasInpaintEditor';
import { CanvasOutpaintEditor } from '@/components/canvas/CanvasOutpaintEditor';
import type { CanvasMaskEditSubmission } from '@/components/canvas/ImageEditorShell';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { SwapLabel } from '@/components/ui/swap-label';
import { useRetained } from '@/components/ui/retained';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AnnotationFullscreen } from '@/components/canvas/annotation/AnnotationFullscreen';
import { useAnnotationEditor } from '@/components/canvas/annotation/useAnnotationEditor';
import { moveLayerStackPart, orderedLayerStackParts } from '@/components/canvas/canvasLayerOrder';
import { notify } from '@/lib/notify';
import { errorText } from '@/lib/errorText';
import { shakeOnError } from '@/lib/motion';
import type { AnnotationElement, CanvasDocument, CanvasImageNode, CanvasLayerStackNode, CanvasMediaVersion, CanvasNode, CanvasTextVersion } from '@/schema/canvas';
import type { CollabRoom } from './useCollabRoom';

export function SharedNodeEdit({open, node, doc, room, close}: {
  open: boolean; node: CanvasNode; doc: CanvasDocument; room: Pick<CollabRoom, 'submitAndWait' | 'connected'>; close: () => void;
}) {
  const textVersionId = node.type === 'text' ? node.data.current_version_id : null;
  // 打开时的基线：正文、标题与正文版本。保存成功后换成刚确认的那一份。
  const [initial, setInitial] = useState(() => {
    const version = textVersionId ? doc.content_versions[textVersionId] : undefined;
    return {revision: doc.revision, title: node.title, content: version?.kind === 'text' ? version.text : '', versionId: textVersionId};
  });
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const shownError = useRetained(error || null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const draft = useRef({title, content, open});
  draft.current = {title, content, open};
  const alive = useRef(true);
  // StrictMode 会先清理再重建 effect：建立时恢复 true，否则开发环境里保存永远不收尾。
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** 本次提交的锁：在第一个 await 之前就拿住，摘要算完前再点一次不会生成第二份版本。 */
  const locked = useRef(false);
  type Submission = {title:string; content:string; op:Parameters<CollabRoom['submitAndWait']>[0]; revision:number; opId:string; versionId?:string};
  /** 上一次没等到确认的提交：同一份草稿重试沿用它的 op_id 与提交体，房主已落盘时只回原结果。 */
  const attempt = useRef<Submission | null>(null);
  function settled(snapshot:{title:string; content:string}, revision:number, versionId:string | undefined) {
    if (!alive.current) return;
    const now = draft.current;
    // 只关仍停在这份快照上的弹窗；等待期间又改了的留着，基线换成刚确认的那一份。
    if (now.open && now.title === snapshot.title && now.content === snapshot.content) close();
    else setInitial(current => ({revision, title: snapshot.title.trim(), content: snapshot.content, versionId: versionId ?? current.versionId}));
  }
  function conflict(message:string) {
    setInitial(current => ({...current, versionId: textVersionId}));
    setError(message);
    shakeOnError(saveButton.current);
  }
  async function save(event:React.FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    try { await submit(); } finally { locked.current = false; }
  }
  async function submit() {
    // 先锁定这次提交的快照：摘要计算和等待确认期间的新输入不算在这次里。
    const snapshot = {title, content};
    const previous = attempt.current;
    let submission = previous && previous.title === snapshot.title && previous.content === snapshot.content ? previous : null;
    if (submission?.versionId) {
      // 同稿重试前先核对重连后的快照：已是这次的版本就当已成功；出现第三个版本就留着草稿提示冲突；仍是原基线才幂等重发。
      if (textVersionId === submission.versionId) { attempt.current = null; settled(snapshot, doc.revision, submission.versionId); return; }
      if (textVersionId !== initial.versionId) { attempt.current = null; conflict('正文已被他人更新，再次保存将覆盖'); return; }
    }
    if (!submission) {
      // 重连回来后正文已被别人改过：先提示一次，再点保存才覆盖。
      if (node.type === 'text' && snapshot.content !== initial.content && textVersionId !== initial.versionId) {
        conflict('正文已被他人更新，再次保存将覆盖');
        return;
      }
      const patch: Record<string, unknown> = {};
      const versions: CanvasTextVersion[] = [];
      if (snapshot.title !== initial.title && snapshot.title.trim() !== initial.title) patch.title = snapshot.title.trim();
      if (node.type === 'text' && snapshot.content !== initial.content) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot.content));
        const version: CanvasTextVersion = {
          version_id: 'version-' + crypto.randomUUID(), created_at: new Date().toISOString(),
          origin: {kind:'user_edit'}, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join(''),
          kind:'text', text:snapshot.content,
        };
        versions.push(version);
        patch.data = {current_version_id:version.version_id};
      }
      if (!Object.keys(patch).length) { close(); return; }
      submission = {...snapshot, op:{kind:'node_update',node_id:node.id, patch,text_versions:versions},
        revision:initial.revision, opId:crypto.randomUUID(), versionId:versions[0]?.version_id};
      attempt.current = submission;
    }
    // 等房主确认再关：被拒、断线或超时都留在弹窗里，正文不丢。
    setSaving(true); setError('');
    try {
      const {revision} = await room.submitAndWait(submission.op, submission.revision, submission.opId);
      if (attempt.current === submission) attempt.current = null;
      settled(snapshot, revision, submission.versionId);
    } catch (reason) {
      if (!alive.current) return;
      setError(errorText(reason));
      shakeOnError(saveButton.current);
    } finally { if (alive.current) setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={next => {if (!next) close();}}>
    <DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>编辑节点</DialogTitle></DialogHeader>
      <form autoComplete="off" className="grid gap-3" onSubmit={event => void save(event)}>
        <Label htmlFor="collab-node-title">标题</Label><Input id="collab-node-title" value={title} maxLength={120} required onChange={event => setTitle(event.target.value)} />
        {node.type === 'text' && <><Label htmlFor="collab-node-text">正文</Label><Textarea id="collab-node-text" value={content} maxLength={40000} onChange={event => setContent(event.target.value)} /></>}
        <Collapse open={Boolean(error)}><p role="alert" className="text-sm text-destructive">{shownError}</p></Collapse>
        <DialogFooter><Button ref={saveButton} type="submit" disabled={saving || !title.trim() || !room.connected}>
          <SwapLabel active={saving} on="保存中…" off="保存" />
        </Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function SharedAnnotation({open,room,node,version,url,close}:{
  open:boolean; room:CollabRoom; node:CanvasImageNode; version:CanvasMediaVersion; url:string; close:()=>void;
}) {
  const width = version.width ?? 1024;
  const height = version.height ?? 1024;
  const annotation = node.data.annotation;
  // 节点还是打开时那张图：换了图，房主那份标注属于新图，不拿来合并，也不往新图上补发。
  const sameImage = node.data.current_version_id === version.version_id;
  const shared = useMemo(() => annotation && annotation.version_id === version.version_id ? annotation.elements : [],
    [annotation, version.version_id]);
  const draftKey = node.id + ':' + version.version_id;
  const [, rerender] = useReducer((count:number) => count + 1, 0);
  const pendingDraft = annotationDrafts.get(draftKey) ?? null;
  const elements = useMemo(() => pendingDraft ? mergeAnnotation(shared, pendingDraft) : shared, [shared, pendingDraft]);
  const warned = useRef(false);
  function storeDraft(key:string, next:AnnotationDraft | null) {
    if (next) annotationDrafts.set(key, next); else annotationDrafts.delete(key);
    rerender();
  }
  function warn(message:string) {
    if (warned.current) return;
    warned.current = true;
    notify.error(message);
  }
  function commit(next:AnnotationElement[]) {
    const key = draftKey;
    storeDraft(key, {elements:next, base:shared});
    if (!sameImage) { warn('节点图片已被更换，标注未保存'); return; }
    room.submitAndWait({kind:'annotation_update',node_id:node.id,
      patch:{data:{annotation:next.length ? {version_id:version.version_id,elements:next,visible:true,rendered_version_id:null,markup_version_id:null} : null}}})
      .then(() => {
        warned.current = false;
        if (annotationDrafts.get(key)?.elements === next) storeDraft(key, null);
      }, reason => warn(room.connected ? errorText(reason) : '连接已断开，重连后自动保存'));
  }
  // 重连（含收起后仍挂着、重新打开）时补发：每次都从最新房主快照按元素 ID 合并，不拿旧节点整份覆盖。
  const resend = useRef(() => {});
  resend.current = () => { if (pendingDraft && sameImage) commit(elements); };
  useEffect(() => { if (room.connected) resend.current(); }, [room.connected]);
  const editor = useAnnotationEditor({enabled:open,width,height,elements,
    onCommit:commit,onError:notify.error,onExit:close,undo:room.undo,redo:room.redo});
  return <AnnotationFullscreen open={open} title={node.title} width={width} height={height} src={url} editor={editor}
    onCollapse={close} undo={room.undo} redo={room.redo} canUndo={room.canUndo} canRedo={room.canRedo} />;
}

interface AnnotationDraft { elements: AnnotationElement[]; base: AnnotationElement[] }
/** 没确认的标注草稿，按「节点:图片版本」存在模块里：收起、重挂、重新鉴权都不丢，换了图也不会补发到新图上。 */
const annotationDrafts = new Map<string, AnnotationDraft>();

/** 本地草稿与房主那份按元素 ID 合并：本地改过或删掉的以本地为准（冲突时保留草稿）；
 *  本地没碰的跟随房主（别人改了就用别人的，别人删了就删）；别人新加的接在后面。 */
function mergeAnnotation(shared:AnnotationElement[], draft:AnnotationDraft):AnnotationElement[] {
  const base = new Map(draft.base.map(element => [element.id, JSON.stringify(element)]));
  const remote = new Map(shared.map(element => [element.id, element]));
  const mine = new Set(draft.elements.map(element => element.id));
  const merged = draft.elements.flatMap(element => {
    const untouched = base.get(element.id) === JSON.stringify(element);
    if (!untouched) return [element];
    const latest = remote.get(element.id);
    return latest ? [latest] : [];
  });
  return [...merged, ...shared.filter(element => !mine.has(element.id) && !base.has(element.id))];
}

export function SharedLayerOrder({node,room}: {node:CanvasLayerStackNode;room:CollabRoom}) {
  const parts = orderedLayerStackParts(node);
  return <div className="grid gap-1">{parts.map((part,i) =>
    <div key={part.key} className="flex items-center gap-2 text-sm"><span className="flex-1">{part.name}</span>
      {(['down','up'] as const).map(direction => <Button key={direction} size="sm" variant="ghost"
        disabled={!room.connected || (direction === 'down' ? i === 0 : i === parts.length - 1)} onClick={() => {
          const ordered = moveLayerStackPart(node, part.key, parts[i + (direction === 'down' ? -1 : 1)].key, direction === 'down');
          if (ordered) room.submit({kind:'layer_order_update',node_id:node.id,
            patch:{data:{layers:ordered.data.layers,base_z_index:ordered.data.base_z_index}}});
        }}>{direction === 'down' ? '下移' : '上移'}</Button>)}
    </div>)}</div>;
}

export function SharedImageEdit({open,node,version,url,mode,save,close}:{
  open:boolean;node:CanvasNode;version:CanvasMediaVersion;url:string;mode:'inpaint'|'outpaint';
  save:(submission:CanvasMaskEditSubmission)=>Promise<boolean>;close:()=>void;
}) {
  const Editor = mode === 'inpaint' ? CanvasInpaintEditor : CanvasOutpaintEditor;
  return <Editor open={open} title={node.title} version={version} mediaUrl={url} keys={[]} busy={false} error={null}
    saveOnly initialData={node.type === 'image_edit' ? node.data : undefined}
    onOpenChange={open => {if (!open) close();}} onSave={save} onSubmit={save} />;
}
