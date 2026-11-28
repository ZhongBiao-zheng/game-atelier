import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { Background, Handle, Position, ReactFlow, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
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
import { AddIcon, BackIcon, LoadingIcon, MoreIcon, RedoIcon, UndoIcon, UploadIcon } from '@/components/ui/icons';
import { SwapIcon } from '@/components/ui/swap-icon';
import { Hint } from '@/components/ui/tooltip';
import { useRetained, useRetainedSession } from '@/components/ui/retained';
import { markCanvasNodesEntering, playCanvasNodeEntrance } from '@/components/canvas/canvasNodeAttention';
import { MOTION_DURATION, MOTION_EASE, MOTION_SPRING, prefersReducedMotion, shakeOnError, viewportMotionMs } from '@/lib/motion';
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

/** 连接点：沿用主画布的 canvas-node-handle，悬停或选中才淡入；不可编辑时不挂 connectable，一直藏着。 */
function SharedHandle(props: ComponentProps<typeof Handle>) {
  return <Handle {...props} className="canvas-node-handle"><span className="canvas-node-handle-dot" aria-hidden="true" /></Handle>;
}

function SharedNodeCard({data, selected}: NodeProps<SharedNode>) {
  const { node, version, url, member, editable, doc, mediaUrl, projectId } = data;
  const shell = useRef<HTMLDivElement>(null);
  // 别人新加、或重连后才出现的节点：和主画布一样从略小处淡入，只在挂载那一次。
  useLayoutEffect(() => { if (shell.current) playCanvasNodeEntrance(node.id, shell.current); }, [node.id]);
  const inputs = node.type === 'compare' ? Object.fromEntries(doc.connections.flatMap(edge => {
    if (edge.target_node_id !== node.id || edge.role !== 'input' || !isCanvasCompareSlot(edge.slot)) return [];
    const source = doc.nodes.find(n => n.id === edge.source_node_id);
    return source?.type === 'image' ? [[edge.slot,source.data.current_version_id]] : [];
  })) : {};
  const parts = node.type === 'layer_stack' ? orderedLayerStackParts(node).filter(part=>part.visible) : [];
  const annotation = node.type === 'image' && node.data.annotation?.visible ? node.data.annotation : null;
  return <div ref={shell} className={cn('relative h-full w-full rounded-lg border border-border bg-card', selected && 'ring-2 ring-primary',
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
      <SharedHandle key={slot} type="target" id={slot} position={Position.Left} isConnectable={editable}
        style={{top:i === 0 ? '33%' : '66%'}} aria-label={slot === 'before' ? '连接到 Before' : '连接到 After'} />)
      : <SharedHandle type="target" position={Position.Left} isConnectable={editable} aria-label="连接到此节点" />}
    <SharedHandle type="source" position={Position.Right} isConnectable={editable} aria-label="从此节点连接" />
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
  // 编辑入口跟着房主授权走，断线只把它们禁用：抖一下网不让整排按钮消失又弹回。
  const canEdit = Boolean(room && liveRoom.mode === 'edit');
  const offline = !liveRoom.connected;
  const [tool, setTool] = useState<'edit'|'annotation'|'inpaint'|'outpaint'|'layers'|null>(null);
  const [uploading, setUploading] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState<Record<string,CanvasPoint>>({});
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const region = useRef<HTMLElement>(null);
  const {screenToFlowPosition, flowToScreenPosition, setCenter, getZoom} = useReactFlow();
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
  // 首帧快照之后才出现的节点（别人新加、自己新加、重连补上的）点名进场；节点卡片挂载时播。
  const knownNodeIds = useRef<Set<string> | null>(null);
  if (doc) {
    const ids = doc.nodes.map(node => node.id);
    const known = knownNodeIds.current;
    if (known) {
      const fresh = ids.filter(id => !known.has(id));
      if (fresh.length) markCanvasNodesEntering(fresh);
    }
    if (!known || ids.length !== known.size || ids.some(id => !known.has(id))) knownNodeIds.current = new Set(ids);
  }
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
  // 选中节点有没有连线输入（含分组）：提交时房主会展开带上，前端估不准，有就不显示总价。
  const selectedHasInputs = Boolean(doc && selectedNode && doc.connections.some(edge =>
    edge.target_node_id === selectedNode.id && edge.role === 'input'));
  // 编辑弹窗只看 tool：断线、节点被删都不卸掉正在写的内容；关闭期间沿用最后一份播完退场。
  // 会话号按选中 id 记：重新鉴权期间 doc 暂时为空，也不能把弹窗当成新开的一次重挂。
  const toolSession = useRetainedSession(tool && selectedIds.length === 1 ? tool + ':' + selectedIds[0] : null);
  const toolNode = useRetained(tool ? selectedNode : null);
  // 打开编辑器时固定源节点与图片版本：之后别人换图、断线重连都不改它，蒙版和笔画只属于打开时那张图。
  const pinnedTool = useRef<{session:number; nodeId:string; versionId:string | null} | null>(null);
  if (toolSession && selectedNode && pinnedTool.current?.session !== toolSession.session) {
    pinnedTool.current = {session:toolSession.session, nodeId:selectedNode.id, versionId:selectedVersion?.version_id ?? null};
  }
  // 房主重启后要重新鉴权，期间 room 为空、doc 消失：编辑弹窗照旧用最后一份画布，草稿不丢，提交因断线禁用。
  const editDoc = useRetained(doc);
  // 弹窗收起后仍挂着（退场、后台补发）：节点内容始终取最新快照，不用收起那一刻的旧节点。
  const liveToolNode = (editDoc && toolNode && editDoc.nodes.find(node => node.id === toolNode.id)) || toolNode;
  const pinnedVersionId = pinnedTool.current?.versionId;
  const toolVersion = useRetained(pinnedVersionId && editDoc ? editDoc.content_versions[pinnedVersionId] : null);
  const undoTop = useRef(liveRoom.undoTop);
  undoTop.current = liveRoom.undoTop;
  const undoRef = useRef(liveRoom.undo);
  undoRef.current = liveRoom.undo;
  const deleteToast = useRef<{id:string | number; opId:string} | null>(null);
  useEffect(() => {
    const toast = deleteToast.current;
    if (toast && liveRoom.undoTop !== toast.opId) { notify.dismiss(toast.id); deleteToast.current = null; }
  }, [liveRoom.undoTop]);
  const shownTool = toolSession?.value.split(':')[0];
  const deletable = editable && selectedIds.length > 0 && selectedIds.every(id =>
    doc?.nodes.find(node => node.id === id)?.created_by_client === liveRoom.clientId);
  const nodes = useMemo(() => doc?.nodes.map<SharedNode>(node => {
    const version = nodeVersion(node, doc);
    const others = members.filter(member=>member.client_id !== clientId);
    const remote = dragging[node.id] ? undefined : others.find(member=>member.positions?.[node.id])?.positions[node.id];
    const position = dragging[node.id] ?? remote ?? node.position;
    return { id: node.id, type: 'shared', position, hidden:collapsedMembers.has(node.id),
      className: remote ? 'shared-remote-moving' : undefined,
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
  // 详情弹窗关闭的退场里沿用最后一个节点，不在 150ms 里变空。
  const shownDetailId = useRetained(detailId);
  const detailNode = doc?.nodes.find(node => node.id === shownDetailId);
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
    reveal(node);
  }
  /** 和主画布一样：新节点已在视口里就不动；不在时保持缩放、平移到它的中心。 */
  function reveal(node:CanvasNode) {
    if (!doc || !region.current) return;
    const size = canvasNodeRenderedSize(node, doc.content_versions);
    const box = region.current.getBoundingClientRect();
    const start = flowToScreenPosition(node.position);
    const end = flowToScreenPosition({x:node.position.x+size.width,y:node.position.y+size.height});
    if (start.x >= box.left && start.y >= box.top && end.x <= box.right && end.y <= box.bottom) return;
    void setCenter(node.position.x+size.width/2, node.position.y+size.height/2,
      {zoom:getZoom(), duration:viewportMotionMs(MOTION_DURATION.slow)});
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
    if (!files?.length || !editable) return;
    let offset = 0;
    setUploading(count => count + 1);
    try {
      for (const file of Array.from(files)) {
        try {
          const result = await transport.upload(projectId,file,{x:at.x+offset,y:at.y+offset});
          liveRoom.recordCommand(result);setSelectedIds([result.node_id]); offset += 32;
        } catch (reason) {notify.error(errorText(reason)); shakeOnError(uploadButton.current);}
      }
    } finally { setUploading(count => count - 1); }
  }
  // 蒙版编辑保存不了的原因：断线、仅查看、节点被删、原图已更换（蒙版按打开时那张画的，不能保存到新图）。
  const pinnedSource = pinnedTool.current && doc?.nodes.find(node => node.id === pinnedTool.current?.nodeId);
  const imageEditBlocked = !editable ? (offline ? '连接已断开，重连后再保存' : '当前为仅查看')
    : !pinnedSource ? '节点已被删除'
    : doc && nodeVersion(pinnedSource, doc)?.version_id !== pinnedTool.current?.versionId ? '原图已更换' : null;
  async function saveImageEdit(submission:CanvasMaskEditSubmission) {
    const pin = pinnedTool.current;
    if (imageEditBlocked || !doc || !pin?.versionId || !pinnedSource) return false;
    const source = pinnedSource;
    const payload:CanvasImageEditSavePayload = {
      expected_revision:doc.revision,options:submission.options,editor_state:submission.editorState,
      generation_draft:submission.draft,reference_node_id:submission.referenceNodeId,reference_version_id:submission.referenceVersionId,
      ...(source.type === 'image_edit' ? {node_id:source.id} : {source_node_id:source.id,source_version_id:pin.versionId}),
    };
    const result = await transport.saveImageEdit(projectId,payload,submission.mask);
    liveRoom.recordCommand(result);setSelectedIds([result.node_id]); setTool(null); return true;
  }
  /** 删除等房主确认后再给撤销提示，并绑定这次删除：撤销只撤栈顶，栈顶换了（之后又做了别的、或已撤销）就收起提示，不撤错。 */
  function removeWithUndo(op:Parameters<typeof liveRoom.submitAndWait>[0], message:string) {
    liveRoom.submitAndWait(op).then(({opId}) => {
      if (deleteToast.current) notify.dismiss(deleteToast.current.id);
      const id = notify.undo(message, () => { if (undoTop.current === opId) undoRef.current(); });
      deleteToast.current = {id, opId};
    }, reason => notify.error(errorText(reason)));
  }
  function removeSelection() {
    if (selectedEdge) {
      removeWithUndo({kind:'connection_delete',connection_id:selectedEdge}, '已删除连线');
      setSelectedEdge(null);
    } else if (deletable) {
      removeWithUndo({kind:'node_delete',node_ids:selectedIds},
        selectedIds.length === 1 ? '已删除节点' : `已删除 ${selectedIds.length} 个节点`);
      setSelectedIds([]);
    } else if (selectedIds.length) notify.info('仅房主可删除他人创建的节点');
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
  const shownChallenge = useRetainedSession(challenge);
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
      className={cn('canvas-flow canvas-flow-shared', connecting && 'canvas-flow-connecting')} fitView fitViewOptions={{maxZoom: 1}} zoomOnDoubleClick={false} minZoom={0.08} maxZoom={5}
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
      onConnectStart={()=>setConnecting(true)} onConnectEnd={()=>setConnecting(false)}
      isValidConnection={edge=>canCreateCanvasInputConnection(doc,edge)}
      onConnect={edge=>{if (editable && canCreateCanvasInputConnection(doc,edge)) liveRoom.submit({kind:'connection_add',connection:{
        id:'edge-'+crypto.randomUUID(),role:'input',source_node_id:edge.source,target_node_id:edge.target,
        slot:isCanvasCompareSlot(edge.targetHandle) ? edge.targetHandle : null}});}}
      onNodeDoubleClick={(_, node) => showDetails(node.id)}
      onNodeContextMenu={event => event.preventDefault()}>
      <Background />
    </ReactFlow>}
    {/* 与本地画布同一顶栏容器：桌面版避开红绿灯与窗口拖动区，失焦时一起降对比度；状态条在下方同列。 */}
    <div className="canvas-editor-top pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-start gap-2 p-2 sm:gap-3 sm:p-3 md:p-4">
    <header className="pointer-events-auto flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-border bg-glass p-1.5 pr-3 backdrop-blur-glass shell-glow">
      <Button variant="ghost" size="icon" aria-label="返回共享画布" onClick={onBack}><BackIcon /></Button>
      <h1 className="truncate text-sm font-medium">{room?.name ?? '共享画布'}</h1>
      {room && <span className="truncate text-xs text-muted-foreground">{room.owner_display_name} · {canEdit ? '协作中' : '仅查看'}</span>}
      <RoomPresence members={liveRoom.members}/>
      {canEdit && doc && <motion.div layout transition={{layout: MOTION_SPRING.snappy}} className="flex items-center gap-2">
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="添加节点" disabled={offline}><AddIcon/></Button></DropdownMenuTrigger>
          <DropdownMenuContent>{(Object.keys(sharedNodeNames) as SharedNodeKind[]).map(type =>
            <DropdownMenuItem key={type} onSelect={()=>add(newSharedNode(type,doc,center()))}>{sharedNodeNames[type]}</DropdownMenuItem>)}
            {plugins.flatMap(plugin=>plugin.contributes.nodes.map(contribution=><DropdownMenuItem key={plugin.id+contribution.type}
              onSelect={()=>void addPlugin(plugin,contribution).catch(reason=>notify.error(errorText(reason)))}>{contribution.title}</DropdownMenuItem>))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button ref={uploadButton} size="icon" variant="ghost" aria-label="上传素材" aria-busy={uploading > 0}
          disabled={offline || uploading > 0} onClick={()=>uploadRef.current?.click()}>
          <SwapIcon swapKey={uploading > 0}>{uploading > 0 ? <LoadingIcon className="animate-spin"/> : <UploadIcon/>}</SwapIcon>
        </Button>
        <FileInput ref={uploadRef} aria-label="选择共享画布素材" multiple accept="image/*,video/*,audio/*"
          onChange={event=>{void upload(event.target.files,center());event.target.value='';}}/>
        <Button size="icon" variant="ghost" aria-label="撤销我的操作" disabled={offline || !liveRoom.canUndo} onClick={liveRoom.undo}><UndoIcon/></Button>
        <Button size="icon" variant="ghost" aria-label="重做我的操作" disabled={offline || !liveRoom.canRedo} onClick={liveRoom.redo}><RedoIcon/></Button>
      </motion.div>}
    </header>
    {/* 断线 400ms 后才出现：一闪即连上的抖动不出声；连上后 150ms 淡出。 */}
    <AnimatePresence>{room && !error && (liveRoom.closed || liveRoom.reconnecting) && <motion.p key="link-status" role="status"
      className="delayed-reveal rounded-lg border bg-card p-2 text-sm" style={{'--reveal-delay':'400ms'} as CSSProperties}
      exit={{opacity:0, transition:{duration:MOTION_DURATION.fast, ease:MOTION_EASE.subtle}}}>
      {liveRoom.closed || '恢复连接中…'}
    </motion.p>}</AnimatePresence>
    {error && <div role="alert" className="pointer-events-auto flex items-center gap-2 rounded-lg bg-card p-3 text-sm">
      {error}<Button size="sm" variant="outline" onClick={() => setAttempt(n => n + 1)}>重试</Button>
    </div>}
    </div>
    {selectedEdge && canEdit && <Button className="absolute bottom-3 left-3" size="sm" disabled={offline} onClick={removeSelection}>删除连线</Button>}
    {toolSession && liveToolNode && editDoc && <>
      {shownTool === 'edit' && <SharedNodeEdit key={toolSession.session} open={tool === 'edit'} node={liveToolNode} doc={editDoc} room={liveRoom} close={()=>setTool(null)}/>}
      {shownTool === 'annotation' && liveToolNode.type === 'image' && toolVersion?.kind === 'image' &&
        <SharedAnnotation key={toolSession.session} open={tool === 'annotation'} node={liveToolNode} version={toolVersion}
          url={transport.mediaUrl(projectId,toolVersion.version_id)} room={liveRoom} close={()=>setTool(null)}/>}
      {(shownTool === 'inpaint' || shownTool === 'outpaint') && toolVersion?.kind === 'image' &&
        <SharedImageEdit key={toolSession.session} open={tool === shownTool} node={liveToolNode} version={toolVersion}
          url={transport.mediaUrl(projectId,toolVersion.version_id)} mode={shownTool} blocked={imageEditBlocked}
          save={saveImageEdit} close={()=>setTool(null)}/>}
      {shownTool === 'layers' && liveToolNode.type === 'layer_stack' &&
        <Dialog open={tool === 'layers'} onOpenChange={open=>{if (!open) setTool(null);}}><DialogContent aria-describedby={undefined}><DialogHeader>
          <DialogTitle>图层顺序</DialogTitle></DialogHeader><SharedLayerOrder room={liveRoom} node={liveToolNode}/></DialogContent></Dialog>}
    </>}
    {!doc && !error && !challenge && <p role="status" className="delayed-reveal absolute top-1/2 w-full text-center text-sm text-muted-foreground">加载中…</p>}
    {doc && zoomDock}
    <AnimatePresence>{doc && selectedIds.length > 0 && !detailId && <motion.div key="selection-bar" role="toolbar" aria-label="节点操作"
      initial={{opacity:0, y:prefersReducedMotion() ? 0 : 4}} animate={{opacity:1, y:0}}
      exit={{opacity:0, y:prefersReducedMotion() ? 0 : 4, transition:{duration:MOTION_DURATION.fast, ease:MOTION_EASE.subtle}}}
      transition={{duration:MOTION_DURATION.fast, ease:MOTION_EASE.subtle}}
      className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-lg border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
      {canEdit && selectedNode && room && <SharedCanvasGenerate key={selectedNode.id} disabled={offline}
        peerKey={peerKey} projectId={projectId} node={selectedNode} revision={doc.revision}
        frozen={selectedVersion?.frozen_generation} owner={room.owner_display_name} allowBorrow={liveRoom.allowBorrow}
        hasInputs={selectedHasInputs} />}
      <SharedCanvasActions peerKey={peerKey} projectId={projectId} document={doc} nodeIds={selectedIds} className="contents" />
      {canEdit && selectedNode && <Button size="sm" variant="ghost" disabled={offline} onClick={()=>setTool('edit')}>编辑节点</Button>}
      {selectedIds.length === 1 && <Button size="sm" variant="ghost" onClick={() => showDetails(selectedIds[0])}>节点详情</Button>}
      {/* 低频动作收进「更多」，窄屏也不折行；删除放最下。他人创建的节点点了会说明原因。 */}
      {canEdit && <DropdownMenu><Hint label="更多"><DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8" aria-label="更多操作" disabled={offline}><MoreIcon/></Button>
      </DropdownMenuTrigger></Hint>
        <DropdownMenuContent side="top" align="start">
          {selectedNode?.type === 'image' && selectedVersion?.kind === 'image' && <>
            <DropdownMenuItem onSelect={()=>setTool('annotation')}>标注</DropdownMenuItem>
            <DropdownMenuItem onSelect={()=>setTool('inpaint')}>局部修改</DropdownMenuItem>
            <DropdownMenuItem onSelect={()=>setTool('outpaint')}>扩图</DropdownMenuItem>
            <DropdownMenuItem onSelect={addLayers}>图层拆分</DropdownMenuItem></>}
          {selectedNode?.type === 'image_edit' && <DropdownMenuItem onSelect={()=>setTool(selectedNode.data.options.mode)}>编辑配置</DropdownMenuItem>}
          {selectedNode?.type === 'layer_stack' && selectedNode.data.layers.length > 0 && <DropdownMenuItem onSelect={()=>setTool('layers')}>图层顺序</DropdownMenuItem>}
          {selectedIds.length > 1 && <DropdownMenuItem onSelect={addGroup}>分组</DropdownMenuItem>}
          {(selectedVersion?.kind === 'image' || selectedNode?.type === 'image_edit' || selectedNode?.type === 'layer_stack' || selectedIds.length > 1) && <DropdownMenuSeparator />}
          <DropdownMenuItem destructive onSelect={removeSelection}>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </motion.div>}</AnimatePresence>
    {doc && detailId && detail?.kind === 'image' && <Lightbox src={transport.mediaUrl(projectId, detail.version_id)} onClose={() => setDetailId(null)}
      meta={{title: detailNode?.title, frozenGeneration: detail.frozen_generation
        ? {generation: detail.frozen_generation, mediaUrl: id => transport.mediaUrl(projectId, id)} : undefined}}
      details={<SharedCanvasActions peerKey={peerKey} projectId={projectId} document={doc} nodeIds={selectedIds} />} />}
    <Dialog open={Boolean(detailId && detailNode && detail?.kind !== 'image')} onOpenChange={open => { if (!open) setDetailId(null); }}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{detailNode?.title}</DialogTitle></DialogHeader>
        {detail && (detail.kind === 'video' ? <video controls src={transport.mediaUrl(projectId, detail.version_id)} className="max-h-96 w-full" />
          : detail.kind === 'audio' ? <audio controls src={transport.mediaUrl(projectId, detail.version_id)} />
          : <p className="whitespace-pre-wrap break-words text-sm">{detail.kind === 'text' && detail.text}</p>)}
        {detail?.frozen_generation && <FrozenGenerationDetails generation={detail.frozen_generation} mediaUrl={id => transport.mediaUrl(projectId, id)} />}
        {doc && <SharedCanvasActions peerKey={peerKey} projectId={projectId} document={doc} nodeIds={selectedIds} />}
      </DialogContent>
    </Dialog>
    {shownChallenge && <SharedCanvasPasscodeDialog key={shownChallenge.session} open={Boolean(challenge)} {...shownChallenge.value}
      peerKey={peerKey} projectId={projectId} onClose={onBack} onEntered={() => { setChallenge(null); setAttempt(n => n + 1); }} />}
  </section>;
}
