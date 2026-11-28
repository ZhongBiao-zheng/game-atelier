import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasDocument, CanvasImageNode } from '@/schema/canvas';
import { ReactFlowProvider } from '@xyflow/react';
import { SharedCanvasView } from './SharedCanvasView';
import { remoteCanvasTransport } from './canvasTransport';
import { RoomPresence } from './RoomPresence';
import { useCollabRoom } from './useCollabRoom';

const doc: CanvasDocument = {
  schema_version:2,revision:2,project_id:'p',updated_at:'now',nodes:[],connections:[],content_versions:{},
  settings:{background:'dots',show_minimap:true,show_image_info:true},viewport:{x:0,y:0,zoom:1},
};
class TestSocket {
  static OPEN = 1;
  static sockets:TestSocket[] = [];
  readyState = TestSocket.OPEN;
  send = vi.fn();
  onopen?:()=>void;
  onclose?:()=>void;
  onmessage?:(event:{data:string})=>void;
  constructor() {TestSocket.sockets.push(this);}
  message(data:unknown) {this.onmessage?.({data:JSON.stringify(data)});}
  close() {this.readyState = 3;this.onclose?.();}
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();TestSocket.sockets=[];});
it('keeps the last snapshot read-only while offline and resumes only after a fresh authorized hello',()=>{
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket',TestSocket);
  const {result,unmount} = renderHook(()=>useCollabRoom('/api/collab/test/ws'));
  const hello={type:'hello_snapshot',mode:'edit',document:doc,members:[],client_id:'me',allow_borrow_provider:false};
  const first=TestSocket.sockets[0];
  act(()=>{first.onopen?.();first.message(hello);});
  expect(result.current.connected).toBe(true);
  expect(result.current.submit({kind:'node_delete',node_ids:['n']})).toBe(true);
  act(()=>first.close());
  expect(result.current.connected).toBe(false);
  expect(result.current.reconnecting).toBe(true);
  expect(result.current.document?.revision).toBe(2);
  expect(result.current.submit({kind:'node_delete',node_ids:['n']})).toBe(false);
  act(()=>{vi.advanceTimersByTime(1000);});
  const second=TestSocket.sockets[1];
  act(()=>{second.onopen?.();second.message({...hello,mode:'view'});});
  expect(result.current.connected).toBe(true);
  expect(result.current.submit({kind:'node_delete',node_ids:['n']})).toBe(false);
  act(()=>{second.message({type:'room_policy_changed',mode:'edit',allow_borrow_provider:true});});
  expect(result.current.submit({kind:'node_delete',node_ids:['n']})).toBe(true);
  unmount();
});

it('lists all online members while limiting the visible avatar row to four',()=>{
  render(<RoomPresence members={Array.from({length:6},(_,i)=>({
    client_id:String(i),display_name:'成员'+i,color_index:i,role:i===0 ? 'owner' : 'guest',selected_node_ids:[],positions:{},
  }))}/>);
  expect(screen.getByLabelText(/在线成员：成员0、成员1、成员2、成员3、成员4、成员5/)).toBeTruthy();
  expect(screen.getByText('+2')).toBeTruthy();
});

it('shows editing controls only while the host authorizes edits and stays connected',async()=>{
  const image = (id:string):CanvasImageNode => ({
    id,type:'image',title:id,position:{x:0,y:0},z_index:0,
    data:{current_version_id:null,active_run_id:null,generation_draft:null,display:{fit:'contain',free_resize:false}},
  });
  const cover = image('cover');
  cover.data.result_stack = {run_id:'run',member_node_ids:['candidate']};
  const graph = {...doc,nodes:[cover,image('candidate')]};
  vi.stubGlobal('WebSocket',TestSocket);
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    const result = url === '/api/profile' ? {display_name:'访客'} : url === '/api/collab/peers'
      ? {shares:[{peer_key:'host',project_id:'p',protocol_version:1,authenticated:true}]}
      : url.endsWith('/document') ? {document:graph,name:'项目',owner_display_name:'房主',mode:'edit',protocol_version:1}
      : {plugins:[]};
    return new Response(JSON.stringify(result));
  }));
  const {unmount} = render(<ReactFlowProvider><SharedCanvasView projectId="p" transport={remoteCanvasTransport('host')}
    onBack={()=>{}} zoomDock={null}/></ReactFlowProvider>);
  await waitFor(()=>expect(TestSocket.sockets).toHaveLength(1));
  const ws=TestSocket.sockets[0];
  act(()=>{ws.onopen?.();ws.message({type:'hello_snapshot',document:graph,members:[],mode:'view',client_id:'me'});});
  expect(screen.getByText('房主 · 仅查看')).toBeInTheDocument();
  expect(screen.queryByTestId('rf__node-candidate')).not.toBeInTheDocument();
  fireEvent.click(await screen.findByLabelText('展开 2 张结果'));
  await waitFor(()=>expect(screen.getByTestId('rf__node-candidate')).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText('收起 2 张结果'));
  await waitFor(()=>expect(screen.queryByTestId('rf__node-candidate')).not.toBeInTheDocument());
  expect(ws.send.mock.calls.map(([message])=>JSON.parse(message).type)).not.toContain('submit_op');
  expect(screen.queryByRole('button',{name:'上传素材'})).not.toBeInTheDocument();
  act(()=>ws.message({type:'room_policy_changed',mode:'edit',allow_borrow_provider:false}));
  expect(screen.getByRole('button',{name:'上传素材'})).toBeEnabled();
  expect(screen.getByRole('button',{name:'添加节点'})).toBeEnabled();
  act(()=>ws.close());
  expect(screen.getByRole('button',{name:'上传素材'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'返回共享画布'})).toBeEnabled();
  unmount();
});
