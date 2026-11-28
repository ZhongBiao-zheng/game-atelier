import { useCallback, useEffect, useRef, useState } from 'react';
import { localConnection } from '@/api/connection';
import { notify } from '@/lib/notify';
import type { CanvasConnection, CanvasDocument, CanvasNode, CanvasPoint, JsonValue } from '@/schema/canvas';
import type { CollabMode } from '@/schema/collab';

export interface RoomMember {
  client_id: string; display_name: string; color_index: number; role: 'owner' | 'guest';
  selected_node_ids: string[]; positions: Record<string, CanvasPoint>;
}

interface DocumentDelta {
  nodes: CanvasNode[]; removed_nodes: string[]; connections: CanvasConnection[]; removed_connections: string[];
  content_versions: CanvasDocument['content_versions']; updated_at: string;
}

function mergeRows<T extends {id: string}>(current: T[], changes: T[], removed: string[]): T[] {
  const updates = new Map(changes.map(row => [row.id, row]));
  const deleted = new Set(removed);
  return [...current.filter(row => !deleted.has(row.id)).map(row => {
    const result = updates.get(row.id);
    updates.delete(row.id);
    return result ?? row;
  }), ...updates.values()];
}

export function applyCollabDelta(doc: CanvasDocument, delta: DocumentDelta, revision: number): CanvasDocument {
  return {...doc, revision, updated_at: delta.updated_at,
    nodes: mergeRows(doc.nodes, delta.nodes, delta.removed_nodes),
    connections: mergeRows(doc.connections, delta.connections, delta.removed_connections),
    content_versions: {...doc.content_versions, ...delta.content_versions}};
}

type OpAction =
  | {kind:'node_add'; node: CanvasNode; text_versions?: CanvasDocument['content_versions'][string][]}
  | {kind:'node_update' | 'annotation_update' | 'image_edit_update' | 'layer_order_update'; node_id:string; patch:Record<string, unknown>; text_versions?: CanvasDocument['content_versions'][string][]}
  | {kind:'plugin_payload_update'; node_id:string; base_payload:JsonValue; patch:Record<string, unknown>}
  | {kind:'node_move_batch'; positions:Record<string,CanvasPoint>}
  | {kind:'node_delete'; node_ids:string[]}
  | {kind:'connection_add'; connection:CanvasConnection}
  | {kind:'connection_delete'; connection_id:string}
  | {kind:'restore'; undo_of:string};

interface HistoryEntry { opId: string; revision: number; touched: string[] }
type Stack = 'past' | 'future';
interface Settle { resolve: () => void; reject: (error: Error) => void }
interface PendingOp { stack: Stack | null; entry?: HistoryEntry; settle?: Settle }

/** 等房主确认一次操作的上限；超时按失败处理，调用方保留弹窗内容。 */
const OP_ACK_TIMEOUT_MS = 10_000;

/** Inverses live on the host, including incident edges and original authorship. */
export class PerUserUndoStack {
  past: HistoryEntry[] = [];
  future: HistoryEntry[] = [];
  private edited = new Map<string, number>();
  changed(ids: string[], revision: number) {
    ids.forEach(id => this.edited.set(id, revision));
  }
  available(stack: Stack) { return this[stack].length > 0; }
  take(stack: Stack) {
    const entry = this[stack].pop();
    if (entry?.touched.some(id => (this.edited.get(id) ?? 0) > entry.revision)) {
      throw new Error('该节点已被他人修改，无法撤回');
    }
    return entry;
  }
  applied(entry: HistoryEntry, stack: Stack | null) {
    if (!stack) this.future.length = 0;
    const dest = stack === 'past' ? this.future : this.past;
    dest.push(entry);
    if (dest.length > 200) dest.shift();
  }
}

export function useCollabRoom(path: string | null, onRevision?: (revision:number) => void) {
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [clientId, setClientId] = useState('');
  const [mode, setMode] = useState<CollabMode>('view');
  const [borrow, setBorrow] = useState(false);
  const [connected, setConnected] = useState(false);
  const [closed, setClosed] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const latest = useRef<CanvasDocument | null>(null);
  const [,setHistoryTick] = useState(0);
  const history = useRef(new PerUserUndoStack());
  const pending = useRef(new Map<string, PendingOp>());
  const presence = useRef({selected_node_ids:[] as string[], positions:{} as Record<string, CanvasPoint>});
  const presenceTimer = useRef<number>();
  const onUpdate = useRef(onRevision);
  onUpdate.current = onRevision;

  useEffect(() => {
    if (!path) { setConnected(false); setMembers([]); setDocument(null); setClosed(''); setReconnecting(false); return; }
    let active = true;
    let retry: number;
    let socket: WebSocket;
    let self = '';
    let tries = 0;
    let roomClosed = false;
    history.current = new PerUserUndoStack();
    latest.current = null;
    setDocument(null);
    setClosed('');
    setReconnecting(false);
    const pendingOps = pending.current;
    function dropPending() {
      pendingOps.forEach(item => item.settle?.reject(new Error('连接已断开，重连后再保存')));
      pendingOps.clear();
    }
    function connect() {
      if (!active || !path) return;
      const url = new URL(path, window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      ws.current = socket;
      socket.onopen = () => socket.send(JSON.stringify({type:'auth', client_id:localConnection.clientId}));
      socket.onmessage = ({data}) => {
        if (!active) return;
        const event = JSON.parse(data);
        if (event.type === 'hello_snapshot') {
          tries = 0;
          self = event.client_id;
          setClientId(self); setMode(event.mode); setBorrow(event.allow_borrow_provider);
          roomClosed = false;
          setConnected(true); setClosed(''); setReconnecting(false); setMembers(event.members);
          latest.current = event.document;
          setDocument(event.document);
          socket.send(JSON.stringify({type:'presence_update', ...presence.current}));
        } else if (event.type === 'presence_state') setMembers(event.members);
        else if (event.type === 'room_policy_changed') { setMode(event.mode); setBorrow(event.allow_borrow_provider); }
        else if (event.type === 'room_closed') { roomClosed = true; setClosed(event.reason); setReconnecting(false); setConnected(false); }
        else if (event.type === 'conflict_notice') notify.info(`该节点已由 ${event.by} 更新`);
        else if (event.type === 'op_rejected') {
          const item = pendingOps.get(event.op_id);
          pendingOps.delete(event.op_id);
          if (item?.entry && item.stack && !String(event.detail).includes('他人')) history.current[item.stack].push(item.entry);
          // 等结果的调用方（弹窗）在原处显示原因，不再另弹提示。
          if (item?.settle) item.settle.reject(new Error(String(event.detail)));
          else notify.error(String(event.detail));
        } else if (event.type === 'op_applied' || event.type === 'document_sync') {
          const before = latest.current;
          let next: CanvasDocument;
          if (event.document) next = event.document;
          else if (before && event.delta && before.revision === event.base_revision)
            next = applyCollabDelta(before, event.delta, event.revision);
          else { socket.close(); return; }
          if (event.client_id === self) {
            const item = pendingOps.get(event.op_id);
            if (item) history.current.applied({opId:event.op_id, revision:event.revision, touched:event.touched_node_ids}, item.stack);
            item?.settle?.resolve();
            pendingOps.delete(event.op_id);
          } else if (event.touched_node_ids) history.current.changed(event.touched_node_ids, event.revision);
          else if (before) {
            const old = new Map(before.nodes.map(node=>[node.id,JSON.stringify(node)]));
            const changed = next.nodes.filter(node=>old.get(node.id) !== JSON.stringify(node)).map(node=>node.id);
            const ids = new Set(next.nodes.map(node=>node.id));
            history.current.changed([...changed,...before.nodes.filter(node=>!ids.has(node.id)).map(node=>node.id)],event.revision);
          }
          latest.current = next;
          setDocument(next);
          onUpdate.current?.(next.revision);
        }
      };
      socket.onclose = () => {
        if (!active) return;
        ws.current = null;
        setConnected(false); setMembers([]);
        // 只有房主明确关房才说离线；其余断线都在重连，界面只降为不可编辑。
        if (!roomClosed) setReconnecting(true);
        dropPending();
        retry = window.setTimeout(connect, Math.min(1000 * 2 ** tries++, 8000));
      };
    }
    connect();
    return () => {
      active = false;
      window.clearTimeout(retry); window.clearTimeout(presenceTimer.current);
      presenceTimer.current = undefined;
      ws.current = null;
      // 离开画布：等结果的调用方也一起卸了，不再回调（避免离开时弹「已断开」）。
      pendingOps.clear();
      socket?.close();
    };
  }, [path]);

  const send = useCallback((op: OpAction, baseRevision?:number, stack:Stack | null = null, entry?:HistoryEntry, settle?:Settle) => {
    const socket = ws.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !latest.current || !connected || mode !== 'edit') return null;
    const opId = crypto.randomUUID();
    pending.current.set(opId, {stack, entry, settle});
    socket.send(JSON.stringify({type:'submit_op', op:{...op, op_id:opId, base_revision:baseRevision ?? latest.current.revision}}));
    return opId;
  }, [connected, mode]);
  const submit = useCallback((op: OpAction, baseRevision?:number, stack:Stack | null = null, entry?:HistoryEntry) =>
    send(op, baseRevision, stack, entry) !== null, [send]);
  /** 提交并等房主确认：applied 时 resolve；被拒、断线或超时 reject，调用方据此保留编辑内容。 */
  const submitAndWait = useCallback((op: OpAction, baseRevision?:number) => new Promise<void>((resolve, reject) => {
    let timer = 0;
    const settle: Settle = {
      resolve: () => { window.clearTimeout(timer); resolve(); },
      reject: error => { window.clearTimeout(timer); reject(error); },
    };
    const opId = send(op, baseRevision, null, undefined, settle);
    if (!opId) { reject(new Error('连接已断开，重连后再保存')); return; }
    timer = window.setTimeout(() => {
      // 记录留着：迟到的确认照样进撤销栈，只是不再回调。已离开画布（记录清空）就不再报。
      const item = pending.current.get(opId);
      if (!item) return;
      item.settle = undefined;
      reject(new Error('房主未响应，请重试'));
    }, OP_ACK_TIMEOUT_MS);
  }), [send]);

  const restore = (stack:Stack) => {
    if (!connected || mode !== 'edit') return;
    try {
      const entry = history.current.take(stack);
      if (entry && !submit({kind:'restore', undo_of:entry.opId}, undefined, stack, entry)) history.current[stack].push(entry);
    } catch (error) { notify.info((error as Error).message); }
  };
  const updatePresence = useCallback((selected: string[], positions: Record<string, CanvasPoint> = {}) => {
    presence.current = {selected_node_ids:selected, positions};
    if (presenceTimer.current !== undefined) return;
    presenceTimer.current = window.setTimeout(() => {
      presenceTimer.current = undefined;
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({type:'presence_update',...presence.current}));
    }, 80);
  }, []);
  function recordCommand(result:{op_id:string; revision:number; touched_node_ids:string[]}) {
    history.current.applied({opId:result.op_id,revision:result.revision,touched:result.touched_node_ids},null);
    setHistoryTick(value=>value+1);
  }
  return {recordCommand,document, members, clientId, mode, allowBorrow:borrow, connected, closed, reconnecting, submit, submitAndWait, updatePresence,
    undo:() => restore('past'), redo:() => restore('future'), canUndo:history.current.available('past'),
    canRedo:history.current.available('future')};
}

export type CollabRoom = ReturnType<typeof useCollabRoom>;
