import type { CanvasDocument } from '@/schema/canvas';

type Rows = {id:string}[];
function changedRows<T extends {id:string}>(before:T[],after:T[]) {
  const old = new Map(before.map(row=>[row.id,row]));
  const changes = new Map<string,T | null>();
  for (const row of after) {
    if (JSON.stringify(old.get(row.id)) !== JSON.stringify(row)) changes.set(row.id,row);
    old.delete(row.id);
  }
  old.forEach((_,id)=>changes.set(id,null));
  return changes;
}

function overlay<T extends Rows[number]>(rows:T[], changes:Map<string,T|null>) {
  const combined = new Map(rows.map(row=>[row.id,row]));
  changes.forEach((row,id)=>{if (row) combined.set(id,row); else combined.delete(id);});
  return Array.from(combined.values());
}

type OwnerHistory = {past:CanvasDocument[];future:CanvasDocument[]};
/** Keep remote changes in every local undo target. Mark only the individual overlapping step as unavailable. */
export function rebaseOwnerHistory(history:OwnerHistory, blocked:WeakSet<CanvasDocument>, current:CanvasDocument,
  base:CanvasDocument, remote:CanvasDocument):OwnerHistory {
  const nodes = changedRows(base.nodes,remote.nodes);
  const edges = changedRows(base.connections,remote.connections);
  if (!nodes.size && !edges.size) return history;
  const touched = new Set(nodes.keys());
  for (const edge of [...base.connections,...remote.connections]) {
    if (edges.has(edge.id)) {touched.add(edge.source_node_id);touched.add(edge.target_node_id);}
  }
  function rebase(stack:CanvasDocument[]) {
    return stack.map((snap,index)=>{
      const newer = stack[index+1] ?? current;
      const affected = changedRows(snap.nodes,newer.nodes);
      const stepEdges = changedRows(snap.connections,newer.connections);
      const clash = [...affected.keys()].some(id=>touched.has(id)) || [...newer.connections,...snap.connections]
        .some(edge=>stepEdges.has(edge.id) && (touched.has(edge.source_node_id) || touched.has(edge.target_node_id)));
      const next = {...snap,nodes:overlay(snap.nodes,nodes),connections:overlay(snap.connections,edges),
        content_versions:{...snap.content_versions,...remote.content_versions}};
      if (clash || blocked.has(snap)) blocked.add(next);
      return next;
    });
  }
  return {past:rebase(history.past),future:rebase(history.future)};
}
