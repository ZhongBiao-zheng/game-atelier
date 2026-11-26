import { CanvasInpaintEditor } from '@/components/canvas/CanvasInpaintEditor';
import { CanvasOutpaintEditor } from '@/components/canvas/CanvasOutpaintEditor';
import type { CanvasMaskEditSubmission } from '@/components/canvas/ImageEditorShell';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AnnotationFullscreen } from '@/components/canvas/annotation/AnnotationFullscreen';
import { useAnnotationEditor } from '@/components/canvas/annotation/useAnnotationEditor';
import { moveLayerStackPart, orderedLayerStackParts } from '@/components/canvas/canvasLayerOrder';
import { notify } from '@/lib/notify';
import type { CanvasDocument, CanvasImageNode, CanvasLayerStackNode, CanvasMediaVersion, CanvasNode, CanvasTextVersion } from '@/schema/canvas';
import type { CollabRoom } from './useCollabRoom';

export function SharedNodeEdit({node, doc, room, close}: {
  node: CanvasNode; doc: CanvasDocument; room: CollabRoom; close: () => void;
}) {
  const [baseRevision] = useState(doc.revision);
  const [title, setTitle] = useState(node.title);
  const current = node.type === 'text' && node.data.current_version_id ? doc.content_versions[node.data.current_version_id] : undefined;
  const [content, setContent] = useState(current?.kind === 'text' ? current.text : '');
  async function save(event:React.FormEvent) {
    event.preventDefault();
    const patch: Record<string, unknown> = {};
    const versions: CanvasTextVersion[] = [];
    if (title.trim() !== node.title) patch.title = title.trim();
    if (node.type === 'text' && content !== (current?.kind === 'text' ? current.text : '')) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      const version: CanvasTextVersion = {
        version_id: 'version-' + crypto.randomUUID(), created_at: new Date().toISOString(),
        origin: {kind:'user_edit'}, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join(''),
        kind:'text', text:content,
      };
      versions.push(version);
      patch.data = {current_version_id:version.version_id};
    }
    if (Object.keys(patch).length) room.submit({kind:'node_update',node_id:node.id, patch,text_versions:versions},baseRevision);
    close();
  }
  return <Dialog open onOpenChange={open => {if (!open) close();}}>
    <DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>编辑节点</DialogTitle></DialogHeader>
      <form autoComplete="off" className="grid gap-3" onSubmit={event => void save(event)}>
        <Label htmlFor="collab-node-title">标题</Label><Input id="collab-node-title" value={title} maxLength={120} required onChange={event => setTitle(event.target.value)} />
        {node.type === 'text' && <><Label htmlFor="collab-node-text">正文</Label><Textarea id="collab-node-text" value={content} maxLength={40000} onChange={event => setContent(event.target.value)} /></>}
        <DialogFooter><Button type="submit" disabled={!title.trim() || !room.connected}>保存</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function SharedAnnotation({room,node,version,url,close}:{
  room:CollabRoom; node:CanvasImageNode; version:CanvasMediaVersion; url:string; close:()=>void;
}) {
  const width = version.width ?? 1024;
  const height = version.height ?? 1024;
  const editor = useAnnotationEditor({enabled:true,width,height,elements:node.data.annotation?.elements ?? [],
    onCommit:elements => room.submit({kind:'annotation_update',node_id:node.id,
      patch:{data:{annotation:elements.length ? {version_id:version.version_id,elements,visible:true,rendered_version_id:null,markup_version_id:null} : null}}}),
    onError:notify.error,onExit:close,undo:room.undo,redo:room.redo});
  return <AnnotationFullscreen open title={node.title} width={width} height={height} src={url} editor={editor}
    onCollapse={close} undo={room.undo} redo={room.redo} canUndo={room.canUndo} canRedo={room.canRedo} />;
}

export function SharedLayerOrder({node,room}: {node:CanvasLayerStackNode;room:CollabRoom}) {
  const parts = orderedLayerStackParts(node);
  return <div className="grid gap-1">{parts.map((part,i) =>
    <div key={part.key} className="flex items-center gap-2 text-sm"><span className="flex-1">{part.name}</span>
      {(['down','up'] as const).map(direction => <Button key={direction} size="sm" variant="ghost"
        disabled={direction === 'down' ? i === 0 : i === parts.length - 1} onClick={() => {
          const ordered = moveLayerStackPart(node, part.key, parts[i + (direction === 'down' ? -1 : 1)].key, direction === 'down');
          if (ordered) room.submit({kind:'layer_order_update',node_id:node.id,
            patch:{data:{layers:ordered.data.layers,base_z_index:ordered.data.base_z_index}}});
        }}>{direction === 'down' ? '下移' : '上移'}</Button>)}
    </div>)}</div>;
}

export function SharedImageEdit({node,version,url,mode,save,close}:{
  node:CanvasNode;version:CanvasMediaVersion;url:string;mode:'inpaint'|'outpaint';
  save:(submission:CanvasMaskEditSubmission)=>Promise<boolean>;close:()=>void;
}) {
  const Editor = mode === 'inpaint' ? CanvasInpaintEditor : CanvasOutpaintEditor;
  return <Editor open title={node.title} version={version} mediaUrl={url} keys={[]} busy={false} error={null}
    saveOnly initialData={node.type === 'image_edit' ? node.data : undefined}
    onOpenChange={open => {if (!open) close();}} onSave={save} onSubmit={save} />;
}
