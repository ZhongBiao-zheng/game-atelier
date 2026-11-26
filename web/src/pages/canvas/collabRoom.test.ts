import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasNode } from '@/schema/canvas';
import { PerUserUndoStack, applyCollabDelta } from './useCollabRoom';
import { rebaseOwnerHistory } from './sharedOwnerHistory';
import { dragPositions, groupSharedNodes } from './sharedGraph';

function node(id:string,x=0):CanvasNode {
  return {id,type:'text',title:id,position:{x,y:20},size:{width:300,height:150},z_index:0,
    data:{display:{scale:'sm'},current_version_id:null,generation_draft:null,active_run_id:null}};
}
function document(nodes:CanvasNode[]):CanvasDocument {
  return {project_id:'canvas',revision:1,schema_version:2,updated_at:'now',nodes,connections:[],content_versions:{},
    settings:{background:'dots',show_image_info:true,show_minimap:true},viewport:{x:0,y:0,zoom:1}};
}
describe('shared editing history',()=>{
  it('preserves unrelated guest changes while undoing on the owner',()=>{
    const initial=document([node('A')]);
    const edited=document([node('A',10)]);
    const remote=document([node('A',10),node('B')]);
    const blocked=new WeakSet<CanvasDocument>();
    const history=rebaseOwnerHistory({past:[initial],future:[]},blocked,edited,edited,remote);
    expect(history.past[0].nodes).toEqual([node('A'),node('B')]);
    expect(blocked.has(history.past[0])).toBe(false);
  });
  it('disables only the individual undo step overwritten by a foreign edit',()=>{
    const initial=document([node('A'),node('B')]);
    const middle=document([node('A',10),node('B')]);
    const current=document([node('A',10),node('B',30)]);
    const remote=document([node('A',40),node('B',30)]);
    const blocked=new WeakSet<CanvasDocument>();
    const history=rebaseOwnerHistory({past:[initial,middle],future:[]},blocked,current,current,remote);
    expect(history.past.map(snap=>blocked.has(snap))).toEqual([true,false]);
    expect(history.past[1].nodes).toEqual([node('A',40),node('B')]);
  });
  it('moves an acknowledged inverse to redo and invalidates overlapping history',()=>{
    const stack=new PerUserUndoStack();
    stack.applied({opId:'add',revision:2,touched:['A']},null);
    stack.changed(['B'],3);
    expect(stack.take('past')?.opId).toBe('add');
    stack.applied({opId:'undo',revision:4,touched:['A']},'past');
    stack.changed(['A'],5);
    expect(()=>stack.take('future')).toThrow('已被他人修改');
  });
  it('applies additions, edits and deletions without moving unaffected rows',()=>{
    const base=document([node('A'),node('B'),node('C')]);
    const next=applyCollabDelta(base,{removed_nodes:['C'],nodes:[node('B',30),node('D')],connections:[],
      removed_connections:[],content_versions:{},updated_at:'later'},8);
    expect(next.nodes).toEqual([node('A'),node('B',30),node('D')]);
    expect(next.nodes[0]).toBe(base.nodes[0]);
    expect(next.revision).toBe(8);
  });
  it('moves grouped nodes using the same delta as their group frame',()=>{
    const base=document([node('A'),node('B',100)]);
    const group=groupSharedNodes(base,['A','B']);
    const positions=dragPositions({...base,nodes:[...base.nodes,group]},[{id:group.id,
      position:{x:group.position.x+40,y:group.position.y-20}}]);
    expect(positions.A).toEqual({x:40,y:0});
    expect(positions.B).toEqual({x:140,y:0});
  });
});
