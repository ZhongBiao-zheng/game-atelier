import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Background, Handle, Position, ReactFlow, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { authenticateCollab, listCollabPeers } from '@/api/collab';
import { AnnotationLayer } from '@/components/canvas/annotation/AnnotationLayer';
import { ResultStackChrome } from '@/components/canvas/CanvasEditorViews';
import { resultStackMembers, resultStackOwners } from '@/lib/canvasResultStacks';
import { CanvasCompareSurface } from '@/components/canvas/CanvasCompareSurface';
import { SharedPluginNodeBody } from '@/components/canvas/SharedPluginNodeBody';
import { orderedLayerStackParts } from '@/components/canvas/canvasLayerOrder';
import { SharedAnnotation, SharedImageEdit, SharedLayerOrder, SharedNodeEdit } from './SharedNodeTools';
import { useCollabRoom, type RoomMember } from './useCollabRoom';
import { RoomPresence, memberColor } from './RoomPresence';
import { dragPositions, groupSharedNodes, newSharedNode, sharedNodeNames, type SharedNodeKind } from './sharedGraph';
import { FileInput } from '@/components/ui/file-input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { notify } from '@/lib/notify';
import type { CanvasImageEditSavePayload } from '@/api/canvas';
import type { CanvasMaskEditSubmission } from '@/components/canvas/ImageEditorShell';
import { enabledPlugins, usePlugins } from '@/plugin-host/registry';
import { loadHostPlugin } from '@/plugin-host/hostPlugins';
import type { PluginPackageLock, PluginNodeContribution } from '@/schema/plugins';
import { Lightbox } from '@/components/Lightbox';
import { ApiError } from '@/api/http';
import { fetchProfile } from '@/api/teamLibraries';
import { FrozenGenerationDetails } from '@/components/canvas/FrozenGenerationDetails';
import { SharedCanvasGenerate } from '@/components/canvas/SharedCanvasGenerate';
import { SharedGenerationStatus } from '@/components/canvas/SharedGenerationStatus';
import { SharedCanvasActions } from '@/components/canvas/SharedCanvasActions';
import { SharedCanvasPasscodeDialog } from '@/components/canvas/SharedCanvasPasscodeDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AddIcon, BackIcon, RedoIcon, UndoIcon, UploadIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/errorText';
import type { CanvasContentVersion, CanvasDocument, CanvasNode, CanvasPoint, JsonValue } from '@/schema/canvas';
import { COLLAB_PROTOCOL_VERSION, type CollabDocument } from '@/schema/collab';
import { canCreateCanvasInputConnection, canvasNodeRenderedSize, isCanvasCompareSlot, placeCanvasNodeWithoutOverlap } from '../canvasEditorModel';
import type { remoteCanvasTransport } from './canvasTransport';

type Transport = ReturnType<typeof remoteCanvasTransport>;
type SharedNode = Node<{
  node: CanvasNode; version?: CanvasContentVersion; url?: string; member?: RoomMember; editable:boolean;
  stackTotal:number; stackExpanded:boolean; toggleStack:(id:string)=>void;
  doc:CanvasDocument; projectId:string; mediaUrl:(id:string)=>string; onPayloadChange:(payload:JsonValue,basePayload:JsonValue)=>void;
}, 'shared'>;
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
  const { node, version, url, member, editable, doc, mediaUrl, projectId } = data;
  const inputs = node.type === 'compare' ? Object.fromEntries(doc.connections.flatMap(edge => {
    if (edge.target_node_id !== node.id || edge.role !== 'input' || !isCanvasCompareSlot(edge.slot)) return [];
    const source = doc.nodes.find(n => n.id === edge.source_node_id);
    return source?.type === 'image' ? [[edge.slot,source.data.current_version_id]] : [];
  })) : {};
  const parts = node.type === 'layer_stack' ? orderedLayerStackParts(node).filter(part=>part.visible) : [];
  const annotation = node.type === 'image' && node.data.annotation?.visible ? node.data.annotation : null;
  return <div className={cn('relative h-full w-full rounded-lg border border-border bg-card', selected && 'ring-2 ring-primary',
    node.type === 'group' && 'border-dashed bg-transparent')} style={member ? {outline:'2px solid '+memberColor(member)} : undefined}>
    {member && <span className="absolute bottom-full right-0 z-10 rounded bg-card px-1 text-xs" style={{color:memberColor(member)}}>{member.display_name}</span>}
    <div className="absolute inset-x-0 bottom-full truncate pb-1 text-sm font-medium">{node.title}</div>
    <SharedGenerationStatus run={node.collab_run} />
    {node.hidden ? <p className="p-3 text-sm text-muted-foreground">内容已遮盖</p>
      : node.type === 'compare' ? <CanvasCompareSurface projectId={projectId} title={node.title} beforeVersionId={inputs.before ?? null}
        afterVersionId={inputs.after ?? null} frame={null} afterSize={null} bitmapWidth={400} resolveMediaUrl={mediaUrl} />
      : node.type === 'plugin' ? <div className="size-full" onDoubleClick={event=>{if (editable) event.stopPropagation();}}>
        <SharedPluginNodeBody node={node} document={doc} projectId={projectId} mediaUrl={mediaUrl}
          editable={editable} onPayloadChange={data.onPayloadChange} /></div>
      : parts.length > 0 ? parts.map(part => <img key={part.key} src={mediaUrl(part.versionId)} alt={part.name}
          loading="lazy" className="pointer-events-none absolute inset-0 size-full object-contain" />)
      : version?.kind === 'image' ? <img src={url} alt={node.title} loading="lazy" className="media-checker size-full rounded-lg object-contain" />
      : version?.kind === 'text' ? <p className="h-full overflow-hidden whitespace-pre-wrap break-words p-3 text-sm">{version.text}</p>
      : version ? <p className="p-3 text-sm text-muted-foreground">{version.kind === 'audio' ? '音频' : '视频'}</p>
      : null}
    {data.stackTotal > 1 && <ResultStackChrome total={data.stackTotal} expanded={data.stackExpanded}
      onToggle={() => data.toggleStack(node.id)} />}
    {annotation && version?.kind === 'image' && <AnnotationLayer elements={annotation.elements} imageWidth={version.width ?? 1024}
      imageHeight={version.height ?? 1024} className="pointer-events-none absolute inset-0 size-full" />}
    {node.type === 'compare' ? (['before','after'] as const).map((slot,i) =>
      <Handle key={slot} type="target" id={slot} position={Position.Left} isConnectable={editable}
        style={{top:i === 0 ? '33%' : '66%'}} title={slot} className={editable ? '' : 'pointer-events-none opacity-0'} />)
      : <Handle type="target" position={Position.Left} isConnectable={editable} className={editable ? '' : 'pointer-events-none opacity-0'} />}
    <Handle type="source" position={Position.Right} isConnectable={editable} className={editable ? '' : 'pointer-events-none opacity-0'} />
  </div>;
}

export function SharedCanvasView({ transport, projectId, onBack, zoomDock }: {
  transport: Transport; projectId: string; onBack: () => void; zoomDock: ReactNode;
}) {
  const { peerKey } = transport;
  const plugins = enabledPlugins(usePlugins()).filter(plugin=>plugin.runtime === 'host');
  const [room, setRoom] = useState<CollabDocument | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [challenge, setChallenge] = useState<{name: string; needsName: boolean; needsCode: boolean} | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);

  const liveRoom = useCollabRoom(room ? transport.wsPath(projectId) : null);
  const connected = useRef(false);
  connected.current = liveRoom.connected;
  const editable = Boolean(room && liveRoom.connected && liveRoom.mode === 'edit');
  const [tool, setTool] = useState<'edit'|'annotation'|'inpaint'|'outpaint'|'layers'|null>(null);
  const [dragging, setDragging] = useState<Record<string,CanvasPoint>>({});
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const region = useRef<HTMLElement>(null);
  const {screenToFlowPosition, fitView} = useReactFlow();
  const {updatePresence, submit, members, clientId} = liveRoom;
  const dragRevision = useRef<number>();
  useEffect(() => { updatePresence(selectedIds); }, [selectedIds,updatePresence]);

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
      if (!first && connected.current) {
        timer = window.setTimeout(() => void read(), 5000);
        return;
      }
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

  const doc = room ? liveRoom.document ?? room.document : undefined;
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set());
  const owners = useMemo(() => resultStackOwners(doc?.nodes ?? []), [doc?.nodes]);
  const collapsedMembers = useMemo(() => new Map(
    [...owners].filter(([,cover]) => !expandedStacks.has(cover)),
  ), [owners, expandedStacks]);
  const toggleStack = useCallback((id:string) => {
    setExpandedStacks(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  useEffect(() => {
    setSelectedIds(previous => previous.some(id => collapsedMembers.has(id))
      ? previous.filter(id => !collapsedMembers.has(id)) : previous);
  }, [collapsedMembers]);
  const selectedNode = selectedIds.length === 1 ? doc?.nodes.find(node=>node.id === selectedIds[0]) : undefined;
  const selectedVersion = doc && selectedNode ? nodeVersion(selectedNode,doc) : undefined;
  const deletable = editable && selectedIds.length > 0 && selectedIds.every(id =>
    doc?.nodes.find(node => node.id === id)?.created_by_client === liveRoom.clientId);
  const nodes = useMemo(() => doc?.nodes.map<SharedNode>(node => {
    const version = nodeVersion(node, doc);
    const others = members.filter(member=>member.client_id !== clientId);
    const position = dragging[node.id] ?? others.find(member=>member.positions?.[node.id])?.positions[node.id] ?? node.position;
    return { id: node.id, type: 'shared', position, hidden:collapsedMembers.has(node.id),
      draggable:editable && !owners.has(node.id), zIndex: node.type === 'group' ? -1 : node.z_index,
      style: canvasNodeRenderedSize(node, doc.content_versions), selected: selectedIds.includes(node.id),
      data: {node,version,editable,doc,projectId,
        stackTotal:node.type === 'image' && node.data.result_stack ? 1 + resultStackMembers(doc,node).length : 0,
        stackExpanded:expandedStacks.has(node.id), toggleStack, member:others.find(member=>member.selected_node_ids.includes(node.id)),
        url:version?.kind === 'image' ? transport.mediaUrl(projectId, version.version_id,400) : undefined,
        mediaUrl:id=>transport.mediaUrl(projectId,id,400),
        onPayloadChange:(payload,basePayload)=>submit({kind:'plugin_payload_update',node_id:node.id,base_payload:basePayload,patch:{data:{payload}}})},
    };
  }) ?? [], [doc, projectId, transport, selectedIds, dragging, editable, members, clientId, submit, owners, collapsedMembers, expandedStacks, toggleStack]);
  const edges = useMemo(() => doc?.connections.flatMap(edge => {
    const source = collapsedMembers.get(edge.source_node_id) ?? edge.source_node_id;
    const target = collapsedMembers.get(edge.target_node_id) ?? edge.target_node_id;
    if (source === target) return [];
    return [{id:edge.id, source, target, selected:edge.id === selectedEdge,
      targetHandle:edge.role === 'input' && isCanvasCompareSlot(edge.slot) ? edge.slot : undefined}];
  }) ?? [], [doc,selectedEdge,collapsedMembers]);
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

  function center() {
    const box = region.current!.getBoundingClientRect();
    return screenToFlowPosition({x:box.left+box.width/2,y:box.top+box.height/2});
  }
  function add(node:CanvasNode) {
    const versions:CanvasContentVersion[] = [];
    if (node.type === 'text' && !node.data.current_version_id) {
      const id = 'version-'+crypto.randomUUID();
      versions.push({kind:'text',version_id:id,text:'',origin:{kind:'user_edit'},created_at:new Date().toISOString(),
        sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'});
      node = {...node,data:{...node.data,current_version_id:id}};
    }
    if (!liveRoom.submit({kind:'node_add',node,text_versions:versions})) return;
    setSelectedIds([node.id]); setSelectedEdge(null);
    window.setTimeout(() => void fitView({nodes:[{id:node.id}],maxZoom:1}),200);
  }
  async function addPlugin(plugin:PluginPackageLock, contribution:PluginNodeContribution) {
    if (!doc) return;
    const module = await loadHostPlugin(plugin.id);
    const type = module?.nodeTypes[contribution.type];
    if (!type?.SharedBody) return;
    add(type.create({id:'plugin-'+crypto.randomUUID(),title:contribution.title,type:'plugin',z_index:0,
      size:contribution.default_size,position:placeCanvasNodeWithoutOverlap(center(),doc.nodes,contribution.default_size),
      data:{plugin_id:plugin.id,node_type:contribution.type,plugin_version:plugin.version,package_digest:plugin.digest,
        data_schema_version:contribution.payload_schema_version,payload:{},generation_draft:null}}));
  }
  function addGroup() {
    if (!doc) return;
    try {add(groupSharedNodes(doc,selectedIds));} catch (reason) {notify.info(errorText(reason));}
  }
  function addLayers() {
    if (!doc || !selectedNode || selectedVersion?.kind !== 'image') return;
    const size = canvasNodeRenderedSize(selectedNode,doc.content_versions);
    const position = placeCanvasNodeWithoutOverlap({x:selectedNode.position.x+size.width+40,y:selectedNode.position.y},doc.nodes,size);
    add({id:'layers-'+crypto.randomUUID(),type:'layer_stack',title:selectedNode.title+' · 图层拆分',size,position,z_index:0,
      data:{source_version_id:selectedVersion.version_id,alias:null,model:null,prompt:'',resolution:'auto',base_version_id:null,
        base_visible:true,base_z_index:0,layers:[],active_run_id:null,error:null}});
  }
  async function upload(files:FileList | null, at:CanvasPoint) {
    if (!files || !editable) return;
    let offset = 0;
    for (const file of Array.from(files)) {
      try {
        const result = await transport.upload(projectId,file,{x:at.x+offset,y:at.y+offset});
        liveRoom.recordCommand(result);setSelectedIds([result.node_id]); offset += 32;
      } catch (reason) {notify.error(errorText(reason));}
    }
  }
  async function saveImageEdit(submission:CanvasMaskEditSubmission) {
    if (!editable || !doc || !selectedNode || !selectedVersion) return false;
    const payload:CanvasImageEditSavePayload = {
      expected_revision:doc.revision,options:submission.options,editor_state:submission.editorState,
      generation_draft:submission.draft,reference_node_id:submission.referenceNodeId,reference_version_id:submission.referenceVersionId,
      ...(selectedNode.type === 'image_edit' ? {node_id:selectedNode.id} : {source_node_id:selectedNode.id,source_version_id:selectedVersion.version_id}),
    };
    const result = await transport.saveImageEdit(projectId,payload,submission.mask);
    liveRoom.recordCommand(result);setSelectedIds([result.node_id]); setTool(null); return true;
  }
  function removeSelection() {
    if (selectedEdge) { liveRoom.submit({kind:'connection_delete',connection_id:selectedEdge}); setSelectedEdge(null); }
    else if (deletable) {liveRoom.submit({kind:'node_delete',node_ids:selectedIds});setSelectedIds([]);}
    else if (selectedIds.length) notify.info('仅房主可删除他人创建的节点');
  }
  useEffect(() => {
    if (!editable || tool || detailId) return;
    function shortcuts(event:KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true],[role=dialog]')) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {event.preventDefault(); if (event.shiftKey) liveRoom.redo(); else liveRoom.undo();}
      if (mod && event.key.toLowerCase() === 'g' && selectedIds.length) {event.preventDefault();addGroup();}
      if (event.key === 'Delete' || event.key === 'Backspace') {event.preventDefault();removeSelection();}
    }
    window.addEventListener('keydown',shortcuts);
    return () => window.removeEventListener('keydown',shortcuts);
  });
  function showDetails(id: string) {
    if (!selectedIds.includes(id)) setSelectedIds([id]);
    setDetailId(id);
  }
  return <section ref={region} onDragOver={event => {if (editable && event.dataTransfer.types.includes('Files')) event.preventDefault();}}
    onDrop={event => {if (editable && event.dataTransfer.files.length) {event.preventDefault();
      void upload(event.dataTransfer.files, screenToFlowPosition({x:event.clientX,y:event.clientY}));}}} aria-label="共享画布编辑器" className="canvas-editor-region relative h-full min-h-0 bg-background">
    {doc && <ReactFlow<SharedNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} proOptions={proOptions}
      nodesDraggable={editable} nodesConnectable={editable} edgesReconnectable={false} deleteKeyCode={null}
      multiSelectionKeyCode={['Shift','Meta','Control']} selectionKeyCode={null}
      className="canvas-flow" fitView fitViewOptions={{maxZoom: 1}} zoomOnDoubleClick={false} minZoom={0.08} maxZoom={5}
      onPaneClick={() => {setSelectedIds([]);setSelectedEdge(null);}}
      onNodesChange={changes=>{
        const selections = changes.filter(change=>change.type === 'select');
        if (selections.length) setSelectedIds(previous=>{
          const next = new Set(previous);
          selections.forEach(change=>change.selected ? next.add(change.id) : next.delete(change.id));
          return Array.from(next);
        });
      }}
      onNodeClick={(_,node)=>{setSelectedEdge(null); if (!editable && !_.ctrlKey && !_.metaKey && !_.shiftKey) setSelectedIds([node.id]);}}
      onNodeDragStart={()=>{dragRevision.current=doc.revision;}}
      onNodeDrag={(_,node,moved)=>{const positions=dragPositions(doc,moved.length ? moved : [node]);
        setDragging(positions);updatePresence(Object.keys(positions),positions);}}
      onNodeDragStop={(_,node,moved)=>{liveRoom.submit({kind:'node_move_batch',positions:dragPositions(doc,moved.length ? moved : [node])},dragRevision.current);
        setDragging({});updatePresence(selectedIds);}}
      onEdgeClick={(_,edge)=>{if (editable) {setSelectedEdge(edge.id);setSelectedIds([]);}}}
      isValidConnection={edge=>canCreateCanvasInputConnection(doc,edge)}
      onConnect={edge=>{if (editable && canCreateCanvasInputConnection(doc,edge)) liveRoom.submit({kind:'connection_add',connection:{
        id:'edge-'+crypto.randomUUID(),role:'input',source_node_id:edge.source,target_node_id:edge.target,
        slot:isCanvasCompareSlot(edge.targetHandle) ? edge.targetHandle : null}});}}
      onNodeDoubleClick={(_, node) => showDetails(node.id)}
      onNodeContextMenu={(event, node) => { event.preventDefault(); showDetails(node.id); }}>
      <Background />
    </ReactFlow>}
    <header className="absolute left-3 top-3 z-10 flex max-w-full items-center gap-2 rounded-xl border border-border bg-glass p-1.5 pr-3 backdrop-blur-glass shell-glow">
      <Button variant="ghost" size="icon" aria-label="返回共享画布" onClick={onBack}><BackIcon /></Button>
      <h1 className="truncate text-sm font-medium">{room?.name ?? '共享画布'}</h1>
      {room && <span className="truncate text-xs text-muted-foreground">{room.owner_display_name} · {editable ? '协作中' : '仅查看'}</span>}
      <RoomPresence members={liveRoom.members}/>
      {editable && doc && <>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="添加节点"><AddIcon/></Button></DropdownMenuTrigger>
          <DropdownMenuContent>{(Object.keys(sharedNodeNames) as SharedNodeKind[]).map(type =>
            <DropdownMenuItem key={type} onSelect={()=>add(newSharedNode(type,doc,center()))}>{sharedNodeNames[type]}</DropdownMenuItem>)}
            {plugins.flatMap(plugin=>plugin.contributes.nodes.map(contribution=><DropdownMenuItem key={plugin.id+contribution.type}
              onSelect={()=>void addPlugin(plugin,contribution).catch(reason=>notify.error(errorText(reason)))}>{contribution.title}</DropdownMenuItem>))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" aria-label="上传素材" onClick={()=>uploadRef.current?.click()}><UploadIcon/></Button>
        <FileInput ref={uploadRef} aria-label="选择共享画布素材" multiple accept="image/*,video/*,audio/*"
          onChange={event=>{void upload(event.target.files,center());event.target.value='';}}/>
        <Button size="icon" variant="ghost" aria-label="撤销我的操作" disabled={!liveRoom.canUndo} onClick={liveRoom.undo}><UndoIcon/></Button>
        <Button size="icon" variant="ghost" aria-label="重做我的操作" disabled={!liveRoom.canRedo} onClick={liveRoom.redo}><RedoIcon/></Button>
      </>}
    </header>
    {room && liveRoom.closed && !error && <p role="status" className="absolute left-3 top-16 rounded-lg border bg-card p-2 text-sm">{liveRoom.closed}</p>}
    {selectedEdge && editable && <Button className="absolute bottom-3 left-3" size="sm" onClick={removeSelection}>删除连线</Button>}
    {editable && selectedNode && tool === 'edit' && doc && <SharedNodeEdit key={selectedNode.id} node={selectedNode} doc={doc} room={liveRoom} close={()=>setTool(null)}/>}
    {editable && selectedNode?.type === 'image' && selectedVersion?.kind === 'image' && tool === 'annotation' &&
      <SharedAnnotation node={selectedNode} version={selectedVersion} url={transport.mediaUrl(projectId,selectedVersion.version_id)}
        room={liveRoom} close={()=>setTool(null)}/>}
    {editable && selectedNode && selectedVersion?.kind === 'image' && (tool === 'inpaint' || tool === 'outpaint') &&
      <SharedImageEdit node={selectedNode} version={selectedVersion} url={transport.mediaUrl(projectId,selectedVersion.version_id)}
        mode={tool} save={saveImageEdit} close={()=>setTool(null)}/>}
    {editable && selectedNode?.type === 'layer_stack' && tool === 'layers' &&
      <Dialog open onOpenChange={open=>{if (!open) setTool(null);}}><DialogContent aria-describedby={undefined}><DialogHeader>
        <DialogTitle>图层顺序</DialogTitle></DialogHeader><SharedLayerOrder room={liveRoom} node={selectedNode}/></DialogContent></Dialog>}
    {error && <div role="alert" className="absolute left-3 top-20 flex items-center gap-2 rounded-lg bg-card p-3 text-sm">
      {error}<Button size="sm" variant="outline" onClick={() => setAttempt(n => n + 1)}>重试</Button>
    </div>}
    {!doc && !error && !challenge && <p role="status" className="absolute top-1/2 w-full text-center text-sm text-muted-foreground">读取共享画布中…</p>}
    {doc && zoomDock}
    {doc && selectedIds.length > 0 && !detailId && <div className="absolute bottom-3 left-3 max-w-full rounded-lg border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
      {editable && selectedNode && room && <SharedCanvasGenerate key={selectedNode.id}
        peerKey={peerKey} projectId={projectId} node={selectedNode} revision={doc.revision}
        frozen={selectedVersion?.frozen_generation} owner={room.owner_display_name} allowBorrow={liveRoom.allowBorrow} />}
      <SharedCanvasActions peerKey={peerKey} projectId={projectId} document={doc} nodeIds={selectedIds} />
      {editable && <>
        {selectedNode && <Button size="sm" variant="ghost" onClick={()=>setTool('edit')}>编辑节点</Button>}
        {selectedNode?.type === 'image' && selectedVersion?.kind === 'image' && <>
          <Button size="sm" variant="ghost" onClick={()=>setTool('annotation')}>标注</Button>
          <Button size="sm" variant="ghost" onClick={()=>setTool('inpaint')}>局部修改</Button>
          <Button size="sm" variant="ghost" onClick={()=>setTool('outpaint')}>扩图</Button>
          <Button size="sm" variant="ghost" onClick={addLayers}>图层拆分</Button></>}
        {selectedNode?.type === 'image_edit' && <Button variant="ghost" size="sm" onClick={()=>setTool(selectedNode.data.options.mode)}>编辑配置</Button>}
        {selectedNode?.type === 'layer_stack' && selectedNode.data.layers.length > 0 && <Button variant="ghost" size="sm" onClick={()=>setTool('layers')}>图层顺序</Button>}
        {selectedIds.length > 1 && <Button size="sm" variant="ghost" onClick={addGroup}>分组</Button>}
        <Button size="sm" variant="ghost" disabled={!deletable} title={deletable ? '删除节点' : '仅房主可删除他人创建的节点'} onClick={removeSelection}>删除</Button>
      </>}
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
