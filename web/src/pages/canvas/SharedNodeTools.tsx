import { CanvasInpaintEditor } from '@/components/canvas/CanvasInpaintEditor';
import { CanvasOutpaintEditor } from '@/components/canvas/CanvasOutpaintEditor';
import type { CanvasMaskEditSubmission } from '@/components/canvas/ImageEditorShell';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  useEffect(() => () => { alive.current = false; }, []);
  /** 上一次没等到确认的提交：同一份草稿重试沿用它的 op_id 与提交体，房主已落盘时只回原结果。 */
  const attempt = useRef<{title:string; content:string; op:Parameters<CollabRoom['submitAndWait']>[0]; revision:number; opId:string} | null>(null);
  async function save(event:React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    // 先锁定这次提交的快照：摘要计算和等待确认期间的新输入不算在这次里。
    const snapshot = {title, content};
    const previous = attempt.current;
    let submission = previous && previous.title === snapshot.title && previous.content === snapshot.content ? previous : null;
    if (!submission) {
      // 重连回来后正文已被别人改过：先提示一次，再点保存才覆盖。
      if (node.type === 'text' && snapshot.content !== initial.content && textVersionId !== initial.versionId) {
        setInitial(current => ({...current, versionId: textVersionId}));
        setError('正文已被他人更新，再次保存将覆盖');
        shakeOnError(saveButton.current);
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
        revision:initial.revision, opId:crypto.randomUUID()};
      attempt.current = submission;
    }
    // 等房主确认再关：被拒、断线或超时都留在弹窗里，正文不丢。
    setSaving(true); setError('');
    try {
      const {revision} = await room.submitAndWait(submission.op, submission.revision, submission.opId);
      if (attempt.current === submission) attempt.current = null;
      if (!alive.current) return;
      const now = draft.current;
      // 只关仍停在这份快照上的弹窗；等待期间又改了的留着，基线换成刚确认的那一份。
      if (now.open && now.title === snapshot.title && now.content === snapshot.content) close();
      else {
        const version = submission.op.kind === 'node_update' ? submission.op.text_versions?.[0]?.version_id : undefined;
        setInitial(current => ({revision, title: snapshot.title.trim(), content: snapshot.content, versionId: version ?? current.versionId}));
      }
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
  const shared = useMemo(() => annotation?.elements ?? [], [annotation]);
  // 没确认的笔画连同它基于的那份标注留在本地：房主确认这一笔才清；断线、被拒都留着，重连后补发。
  const [pendingDraft, setPendingDraft] = useState<AnnotationDraft | null>(null);
  const elements = useMemo(() => pendingDraft ? mergeAnnotation(shared, pendingDraft) : shared, [shared, pendingDraft]);
  const warned = useRef(false);
  function commit(next:AnnotationElement[]) {
    setPendingDraft({elements:next, base:shared});
    room.submitAndWait({kind:'annotation_update',node_id:node.id,
      patch:{data:{annotation:next.length ? {version_id:version.version_id,elements:next,visible:true,rendered_version_id:null,markup_version_id:null} : null}}})
      .then(() => {
        warned.current = false;
        setPendingDraft(current => current?.elements === next ? null : current);
      }, reason => {
        if (warned.current) return;
        warned.current = true;
        notify.error(room.connected ? errorText(reason) : '连接已断开，重连后自动保存');
      });
  }
  const resend = useRef(() => {});
  resend.current = () => { if (pendingDraft) commit(elements); };
  useEffect(() => { if (room.connected) resend.current(); }, [room.connected]);
  const editor = useAnnotationEditor({enabled:open,width,height,elements,
    onCommit:commit,onError:notify.error,onExit:close,undo:room.undo,redo:room.redo});
  return <AnnotationFullscreen open={open} title={node.title} width={width} height={height} src={url} editor={editor}
    onCollapse={close} undo={room.undo} redo={room.redo} canUndo={room.canUndo} canRedo={room.canRedo} />;
}

interface AnnotationDraft { elements: AnnotationElement[]; base: AnnotationElement[] }

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
