import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Background, Handle, Position, ReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { authenticateCollab, listCollabPeers } from '@/api/collab';
import { Lightbox } from '@/components/Lightbox';
import { ApiError } from '@/api/http';
import { fetchProfile } from '@/api/teamLibraries';
import { FrozenGenerationDetails } from '@/components/canvas/FrozenGenerationDetails';
import { SharedCanvasActions } from '@/components/canvas/SharedCanvasActions';
import { SharedCanvasPasscodeDialog } from '@/components/canvas/SharedCanvasPasscodeDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BackIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/errorText';
import type { CanvasContentVersion, CanvasDocument, CanvasNode } from '@/schema/canvas';
import { COLLAB_PROTOCOL_VERSION, type CollabDocument } from '@/schema/collab';
import { canvasNodeRenderedSize } from '../canvasEditorModel';
import type { remoteCanvasTransport } from './canvasTransport';

type Transport = ReturnType<typeof remoteCanvasTransport>;
type SharedNode = Node<{ node: CanvasNode; version?: CanvasContentVersion; url?: string }, 'shared'>;
const nodeTypes = { shared: SharedNodeCard };
const proOptions = { hideAttribution: true };

function nodeVersion(node: CanvasNode, document: CanvasDocument) {
  let id: string | null = null;
  if ('current_version_id' in node.data) id = node.data.current_version_id;
  else if (node.type === 'image_edit') id = node.data.source_version_id;
  else if (node.type === 'layer_stack') id = node.data.base_version_id || node.data.source_version_id;
  return id ? document.content_versions[id] : undefined;
}

function SharedNodeCard({data, selected}: NodeProps<SharedNode>) {
  const { node, version, url } = data;
  return <div className={cn('relative h-full w-full rounded-lg border border-border bg-card', selected && 'ring-2 ring-primary',
    node.type === 'group' && 'border-dashed bg-transparent')}>
    <div className="absolute inset-x-0 bottom-full truncate pb-1 text-sm font-medium">{node.title}</div>
    {node.hidden ? <p className="p-3 text-sm text-muted-foreground">内容已遮盖</p>
      : version?.kind === 'image' ? <img src={url} alt={node.title} loading="lazy" className="media-checker size-full rounded-lg object-contain" />
      : version?.kind === 'text' ? <p className="h-full overflow-hidden whitespace-pre-wrap break-words p-3 text-sm">{version.text}</p>
      : version ? <p className="p-3 text-sm text-muted-foreground">{version.kind === 'audio' ? '音频' : '视频'}</p>
      : node.type === 'plugin' ? <p className="p-3 text-sm text-muted-foreground">{node.data.node_type} · 插件节点</p>
      : null}
    <Handle type="target" position={Position.Left} isConnectable={false} className="pointer-events-none opacity-0" />
    <Handle type="source" position={Position.Right} isConnectable={false} className="pointer-events-none opacity-0" />
  </div>;
}

export function SharedCanvasView({ transport, projectId, onBack, zoomDock }: {
  transport: Transport; projectId: string; onBack: () => void; zoomDock: ReactNode;
}) {
  const { peerKey } = transport;
  const [room, setRoom] = useState<CollabDocument | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [challenge, setChallenge] = useState<{name: string; needsName: boolean; needsCode: boolean} | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: number;
    async function authorize(acceptCached: boolean) {
      const [profile, cards] = await Promise.all([fetchProfile(), listCollabPeers()]);
      if (!live) return false;
      const card = cards.find(item => item.peer_key === peerKey && item.project_id === projectId);
      if (!card) throw new Error('房主已离线');
      if (card.protocol_version !== COLLAB_PROTOCOL_VERSION) throw new Error('对方版本不兼容，请更新');
      if (acceptCached && card.authenticated) return true;
      const needsName = !profile.display_name?.trim();
      if (needsName || card.requires_passcode) {
        setChallenge({name: card.name, needsName, needsCode: card.requires_passcode});
        return false;
      }
      await authenticateCollab(peerKey, projectId);
      return live;
    }
    async function read(first = false) {
      try {
        if (first && !(await authorize(true))) return;
        const result = await transport.read(projectId);
        if (!live) return;
        if (result.protocol_version !== COLLAB_PROTOCOL_VERSION) throw new Error('对方版本不兼容，请更新');
        setRoom(result);
        setChallenge(null);
        setError('');
      } catch (reason) {
        if (!live) return;
        if (reason instanceof ApiError && reason.status === 403) {
          setRoom(null);
          setDetailId(null);
          try {
            if (!(await authorize(false))) return;
          } catch (authError) { if (live) setError(errorText(authError)); }
        } else {
          if (reason instanceof ApiError && reason.status === 404) {
            setRoom(null);
            setDetailId(null);
          }
          setError(errorText(reason));
        }
      }
      if (live) timer = window.setTimeout(() => void read(), 5000);
    }
    void read(attempt === 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [transport, peerKey, projectId, attempt]);

  const doc = room?.document;
  const nodes = useMemo(() => doc?.nodes.map<SharedNode>(node => {
    const version = nodeVersion(node, doc);
    return { id: node.id, type: 'shared', position: node.position, zIndex: node.type === 'group' ? -1 : node.z_index,
      style: canvasNodeRenderedSize(node, doc.content_versions), selected: selectedIds.includes(node.id),
      data: { node, version, url: version?.kind === 'image' ? transport.mediaUrl(projectId, version.version_id, 400) : undefined },
    };
  }) ?? [], [doc, projectId, transport, selectedIds]);
  const edges = useMemo(() => doc?.connections.map(edge => ({
    id: edge.id, source: edge.source_node_id, target: edge.target_node_id,
  })) ?? [], [doc]);
  const detailNode = doc?.nodes.find(node => node.id === detailId);
  const detail = doc && detailNode && nodeVersion(detailNode, doc);

  useEffect(() => {
    if (!doc || !selectedIds.length || detailId) return;
    function copy(event: ClipboardEvent) {
      if (!doc || !event.clipboardData || window.getSelection()?.toString() ||
          (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true],[role=dialog]'))) return;
      const ids = new Set(selectedIds);
      event.clipboardData.setData('application/x-game-atelier-canvas-nodes', JSON.stringify({
        schema_version: 1, source_project_id: projectId, source: { kind: 'remote', peerKey, projectId },
        nodes: doc.nodes.filter(node => ids.has(node.id)), connections: doc.connections.filter(edge =>
          ids.has(edge.source_node_id) && ids.has(edge.target_node_id)),
      }));
      event.preventDefault();
    }
    window.addEventListener('copy', copy);
    return () => window.removeEventListener('copy', copy);
  }, [doc, peerKey, projectId, selectedIds, detailId]);

  function showDetails(id: string) {
    if (!selectedIds.includes(id)) setSelectedIds([id]);
    setDetailId(id);
  }
  return <section aria-label="共享画布编辑器" className="canvas-editor-region relative h-full min-h-0 bg-background">
    {doc && <ReactFlow<SharedNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} proOptions={proOptions}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      className="canvas-flow" fitView fitViewOptions={{maxZoom: 1}} zoomOnDoubleClick={false} minZoom={0.08} maxZoom={5} onPaneClick={() => setSelectedIds([])}
      onNodeClick={(e, node) => setSelectedIds(current => (e.shiftKey || e.metaKey || e.ctrlKey)
        ? current.includes(node.id) ? current.filter(id => id !== node.id) : [...current, node.id]
        : [node.id])}
      onNodeDoubleClick={(_, node) => showDetails(node.id)}
      onNodeContextMenu={(event, node) => { event.preventDefault(); showDetails(node.id); }}>
      <Background />
    </ReactFlow>}
    <header className="absolute left-3 top-3 z-10 flex max-w-full items-center gap-2 rounded-xl border border-border bg-glass p-1.5 pr-3 backdrop-blur-glass shell-glow">
      <Button variant="ghost" size="icon" aria-label="返回共享画布" onClick={onBack}><BackIcon /></Button>
      <h1 className="truncate text-sm font-medium">{room?.name ?? '共享画布'}</h1>
      {room && <span className="truncate text-xs text-muted-foreground">{room.owner_display_name} · 仅查看</span>}
    </header>
    {error && <div role="alert" className="absolute left-3 top-20 flex items-center gap-2 rounded-lg bg-card p-3 text-sm">
      {error}<Button size="sm" variant="outline" onClick={() => setAttempt(n => n + 1)}>重试</Button>
    </div>}
    {!doc && !error && !challenge && <p role="status" className="absolute top-1/2 w-full text-center text-sm text-muted-foreground">读取共享画布中…</p>}
    {doc && zoomDock}
    {doc && selectedIds.length > 0 && !detailId && <div className="absolute bottom-3 left-3 max-w-full rounded-lg border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
      <SharedCanvasActions peerKey={peerKey} projectId={projectId} document={doc} nodeIds={selectedIds} />
      {selectedIds.length === 1 && <Button size="sm" variant="ghost" onClick={() => showDetails(selectedIds[0])}>节点详情</Button>}
    </div>}
    {doc && detail?.kind === 'image' && <Lightbox src={transport.mediaUrl(projectId, detail.version_id)} onClose={() => setDetailId(null)}
      meta={{title: detailNode?.title, frozenGeneration: detail.frozen_generation
        ? {generation: detail.frozen_generation, mediaUrl: id => transport.mediaUrl(projectId, id)} : undefined}}
      details={<SharedCanvasActions peerKey={peerKey} projectId={projectId} document={doc} nodeIds={selectedIds} />} />}
    <Dialog open={Boolean(detailNode && detail?.kind !== 'image')} onOpenChange={open => { if (!open) setDetailId(null); }}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{detailNode?.title}</DialogTitle></DialogHeader>
        {detail && (detail.kind === 'video' ? <video controls src={transport.mediaUrl(projectId, detail.version_id)} className="max-h-96 w-full" />
          : detail.kind === 'audio' ? <audio controls src={transport.mediaUrl(projectId, detail.version_id)} />
          : <p className="whitespace-pre-wrap break-words text-sm">{detail.kind === 'text' && detail.text}</p>)}
        {detail?.frozen_generation && <FrozenGenerationDetails generation={detail.frozen_generation} mediaUrl={id => transport.mediaUrl(projectId, id)} />}
        {doc && <SharedCanvasActions peerKey={peerKey} projectId={projectId} document={doc} nodeIds={selectedIds} />}
      </DialogContent>
    </Dialog>
    {challenge && <SharedCanvasPasscodeDialog {...challenge} peerKey={peerKey} projectId={projectId} onClose={onBack}
      onEntered={() => { setChallenge(null); setAttempt(n => n + 1); }} />}
  </section>;
}
