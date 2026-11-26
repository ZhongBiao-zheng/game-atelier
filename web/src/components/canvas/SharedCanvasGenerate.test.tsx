import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasTextNode } from '@/schema/canvas';
import { SharedCanvasGenerate } from './SharedCanvasGenerate';
import { SharedGenerationStatus } from './SharedGenerationStatus';

const node: CanvasTextNode = {
  id: 'n', type: 'text', title: '脚本', position: {x: 0, y: 0}, z_index: 0,
  data: {current_version_id: null, active_run_id:null, generation_draft:null, display:{scale:'sm'}},
};
afterEach(() => vi.unstubAllGlobals());

it.each([true, false])('按访客可用模型选择费用承担方（有自有模型 %s）', async hasLocal => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    const remote = {channel_id: 'opaque', model: 'script', name: '脚本模型', mode: 'text', provider: 'openai'};
    const local = {alias:'local', provider:'openai', modalities:['llm'], enabled:true,
      models:[{id:'script',name:'脚本模型',modality:'text',input_modalities:['text']}]};
    const result = url.includes('borrowable-models') ? {models:[remote]}
      : url.includes('/keys') ? {keys:hasLocal ? [local] : []} : {};
    return new Response(JSON.stringify(result), {status:200});
  }));
  render(<SharedCanvasGenerate node={node} peerKey="peer" projectId="p" revision={2} owner="画师" allowBorrow />);
  fireEvent.click(screen.getByRole('button', {name:'生成…'}));
  await waitFor(() => expect(screen.getByRole('button', {name:'生成'})).toBeEnabled());
  expect(screen.getByRole('tab', {name:hasLocal ? '我的供应商' : '房主供应商'})).toHaveAttribute('aria-selected','true');
  expect(Boolean(screen.queryByText('本次生成使用房主（画师）的供应商'))).toBe(!hasLocal);
  fireEvent.click(screen.getByRole('button', {name:'生成'}));
  await waitFor(() => expect(requests.some(url => url.endsWith(hasLocal ? '/runs/local' : '/runs/borrowed'))).toBe(true));
});

it('在生成占位节点上显示发起人', () => {
  render(<SharedGenerationStatus run={{run_id:'r',source_node_id:'n',status:'pending',execution_mode:'guest',
    initiated_by:'小林',model:'script',mode:'text',started_at:'2026-11-26T00:00:00Z'}} />);
  expect(screen.getByRole('status')).toHaveTextContent('生成中 · 由小林发起');
});

it('拆层时排除普通图像模型，仅能提交具备拆层能力的房主渠道', async () => {
  const submissions: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body) submissions.push(String(init.body));
    const image = {id:'gpt-image-1', name:'普通出图', modality:'image'};
    const choice = {channel_id:'host', mode:'image', provider:'seedream'};
    const result = url.includes('borrowable-models')
      ? {models:[{...choice, model:'bad', name:'普通图像', supported_operations:[]},
          {...choice, model:'layers', name:'分层模型', supported_operations:['layer_decomposition']}]}
      : url.includes('/keys') ? {keys:[{alias:'mine',enabled:true,provider:'openai',modalities:['image'],models:[image]}]} : {};
    return new Response(JSON.stringify(result), {status:200});
  }));
  render(<SharedCanvasGenerate node={{...node,type:'layer_stack',data:{
    source_version_id:'original', alias:null, model:null, prompt:'拆分', resolution:'auto',
    base_version_id:null,base_visible:true,layers:[],active_run_id:null,error:null,
  }}} peerKey="peer" projectId="p" revision={3} owner="画师" allowBorrow />);
  fireEvent.click(screen.getByRole('button', {name:'生成…'}));
  await waitFor(() => expect(screen.getByRole('tab', {name:'房主供应商'})).toHaveAttribute('aria-selected','true'));
  fireEvent.click(screen.getByRole('button', {name:'生成'}));
  await waitFor(() => expect(JSON.parse(submissions[0]).model).toBe('layers'));
});
