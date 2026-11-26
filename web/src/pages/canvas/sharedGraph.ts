import type { CanvasDocument, CanvasNode, CanvasPoint } from '@/schema/canvas';
import { resultStackMembers } from '@/lib/canvasResultStacks';
import { canvasNodeRenderedSize, placeCanvasNodeWithoutOverlap } from '../canvasEditorModel';

export const sharedNodeNames = {text:'文本',image:'图片',audio:'音频',video:'视频',compare:'对比'} as const;
export type SharedNodeKind = keyof typeof sharedNodeNames;
export function newSharedNode(type: SharedNodeKind, doc: CanvasDocument, center: CanvasPoint): CanvasNode {
  const size = type === 'text' ? {width:288,height:180} : {width:320,height:320};
  const position = placeCanvasNodeWithoutOverlap({x:center.x-size.width/2,y:center.y-size.height/2},doc.nodes,size);
  const base = {id:type+'-'+crypto.randomUUID(),title:sharedNodeNames[type],position,size,z_index:0};
  const content = {current_version_id:null,generation_draft:null,active_run_id:null};
  if (type === 'compare') return {...base,type,data:{}};
  if (type === 'text') return {...base,type,data:{...content,display:{scale:'sm'}}};
  if (type === 'audio') return {...base,type,data:content};
  return {...base,type,data:{...content,display:{fit:'contain',free_resize:false}}};
}

export function groupSharedNodes(doc:CanvasDocument, ids:string[]):CanvasNode {
  const members = doc.nodes.filter(node => ids.includes(node.id));
  const existing = new Set(doc.nodes.flatMap(node => node.type === 'group' ? node.data.member_node_ids : []));
  if (!members.length || members.some(node => node.type === 'group' || existing.has(node.id))) {
    throw new Error('一个节点只能属于一个分组，请先解散原分组');
  }
  const x = Math.min(...members.map(node => node.position.x)) - 24;
  const y = Math.min(...members.map(node => node.position.y)) - 40;
  const right = Math.max(...members.map(node => node.position.x + canvasNodeRenderedSize(node,doc.content_versions).width)) + 24;
  const bottom = Math.max(...members.map(node => node.position.y + canvasNodeRenderedSize(node,doc.content_versions).height)) + 24;
  return {id:'group-'+crypto.randomUUID(),type:'group',title:'分组',position:{x,y},size:{width:right-x,height:bottom-y},z_index:0,
    data:{member_node_ids:members.sort((a,b) => a.position.y-b.position.y || a.position.x-b.position.x).map(node=>node.id)}};
}

export function dragPositions(doc:CanvasDocument, moved:{id:string;position:CanvasPoint}[]) {
  const positions:Record<string,CanvasPoint> = Object.fromEntries(moved.map(node => [node.id,node.position]));
  for (const group of doc.nodes) {
    if (group.type !== 'group' || !positions[group.id]) continue;
    const end = positions[group.id];
    for (const id of group.data.member_node_ids) {
      const member = doc.nodes.find(node => node.id === id);
      if (member && !positions[id]) positions[id] = {x:member.position.x+end.x-group.position.x,y:member.position.y+end.y-group.position.y};
    }
  }
  for (const cover of doc.nodes) {
    if (cover.type !== 'image' || !cover.data.result_stack || !positions[cover.id]) continue;
    const dx = positions[cover.id].x - cover.position.x;
    const dy = positions[cover.id].y - cover.position.y;
    for (const member of resultStackMembers(doc,cover)) {
      positions[member.id] = {x:member.position.x + dx, y:member.position.y + dy};
    }
  }
  return positions;
}
