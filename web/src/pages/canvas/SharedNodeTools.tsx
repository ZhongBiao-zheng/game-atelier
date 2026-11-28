import { CanvasInpaintEditor } from '@/components/canvas/CanvasInpaintEditor';
import { CanvasOutpaintEditor } from '@/components/canvas/CanvasOutpaintEditor';
import type { CanvasMaskEditSubmission } from '@/components/canvas/ImageEditorShell';
import { useEffect, useRef, useState } from 'react';
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
  const [initial] = useState(() => {
    const version = node.type === 'text' && node.data.current_version_id
      ? doc.content_versions[node.data.current_version_id] : undefined;
    return {revision: doc.revision, title: node.title, content: version?.kind === 'text' ? version.text : ''};
  });
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const shownError = useRetained(error || null);
  const saveButton = useRef<HTMLButtonElement>(null);
  async function save(event:React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const patch: Record<string, unknown> = {};
    const versions: CanvasTextVersion[] = [];
    if (title !== initial.title && title.trim() !== initial.title) patch.title = title.trim();
    if (node.type === 'text' && content !== initial.content) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      const version: CanvasTextVersion = {
        version_id: 'version-' + crypto.randomUUID(), created_at: new Date().toISOString(),
        origin: {kind:'user_edit'}, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join(''),
        kind:'text', text:content,
      };
      versions.push(version);
      patch.data = {current_version_id:version.version_id};
    }
    if (!Object.keys(patch).length) { close(); return; }
    // 等房主确认再关：被拒、断线或超时都留在弹窗里，正文不丢。
    setSaving(true); setError('');
    try {
      await room.submitAndWait({kind:'node_update',node_id:node.id, patch,text_versions:versions},initial.revision);
      close();
    } catch (reason) {
      setError(errorText(reason));
      shakeOnError(saveButton.current);
    } finally { setSaving(false); }
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
  const shared = node.data.annotation?.elements ?? [];
  const sharedKey = JSON.stringify(shared);
  // 断线时没发出去的笔画留在本地，房主那边的标注没变就一直显示，重连后补发。
  const [unsent, setUnsent] = useState<{elements:AnnotationElement[]; base:string} | null>(null);
  const local = unsent && unsent.base === sharedKey ? unsent.elements : null;
  function commit(elements:AnnotationElement[]) {
    const sent = room.submit({kind:'annotation_update',node_id:node.id,
      patch:{data:{annotation:elements.length ? {version_id:version.version_id,elements,visible:true,rendered_version_id:null,markup_version_id:null} : null}}});
    if (sent) { setUnsent(null); return; }
    if (!local) notify.error('连接已断开，重连后自动保存');
    setUnsent({elements, base:sharedKey});
  }
  const latestCommit = useRef(commit);
  latestCommit.current = commit;
  useEffect(() => { if (room.connected && local) latestCommit.current(local); }, [room.connected, local]);
  const editor = useAnnotationEditor({enabled:open,width,height,elements:local ?? shared,
    onCommit:commit,onError:notify.error,onExit:close,undo:room.undo,redo:room.redo});
  return <AnnotationFullscreen open={open} title={node.title} width={width} height={height} src={url} editor={editor}
    onCollapse={close} undo={room.undo} redo={room.redo} canUndo={room.canUndo} canRedo={room.canRedo} />;
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
