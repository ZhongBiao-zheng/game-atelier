import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasFrozenGeneration, CanvasImageNode, CanvasTextNode } from '@/schema/canvas';
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
  expect(screen.getByRole('status')).toHaveTextContent('生成中…，由小林发起');
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

it.each([true, false])('回执丢失后复用首次请求，确认后再生成使用新标识（有自有模型 %s）', async hasLocal => {
  sessionStorage.clear();
  const submissions: {request_id: string; expected_revision: number}[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith(hasLocal ? '/runs/local' : '/runs/borrowed')) {
      submissions.push(JSON.parse(String(init?.body)));
      return new Response('{}', {status: [502, 409][submissions.length - 1] ?? 202});
    }
    const model = {id:'script', name:'脚本模型', modality:'text', input_modalities:['text']};
    const result = url.includes('borrowable-models')
      ? {models:[{channel_id:'host', model:'script', name:model.name, mode:'text', provider:'openai'}]}
      : {keys:hasLocal ? [{alias:'local', provider:'openai', modalities:['llm'], models:[model]}] : []};
    return new Response(JSON.stringify(result));
  });
  const properties = {node, peerKey:'peer', projectId:'p', owner:'房主', allowBorrow:true};
  async function openAndSubmit() {
    fireEvent.click(screen.getByRole('button', {name:'生成…'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'生成'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'生成'}));
  }
  const mounted = render(<SharedCanvasGenerate {...properties} revision={1} />);
  await openAndSubmit();
  await screen.findByRole('alert');
  mounted.unmount();
  const reloaded = render(<SharedCanvasGenerate {...properties} revision={3} />);
  await openAndSubmit();
  await screen.findByRole('alert');
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0].request_id).toMatch(/^[a-f0-9]{32}$/);
  expect(submissions[1].expected_revision).toBe(1);
  reloaded.rerender(<SharedCanvasGenerate {...properties} revision={4} />);
  fireEvent.click(screen.getByRole('button', {name:'生成'}));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(submissions[2].request_id).toBe(submissions[0].request_id);
  expect(submissions[2].expected_revision).toBe(4);
  await openAndSubmit();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(submissions[3].request_id).not.toBe(submissions[0].request_id);
});


it.each([false, true])('空图原地生成后重试沿用原始请求体（重新打开 %s）', async reopen => {
  sessionStorage.clear();
  const submissions: {model: string; request_id: string; params: object}[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/runs/borrowed')) {
      submissions.push(JSON.parse(String(init?.body)));
      return new Response('{}', {status: submissions.length < 3 ? 502 : 202});
    }
    const models = ['first', 'another'].map(model => ({
      channel_id:'host-' + model, model, name:model, mode:'image', provider:'openai',
    }));
    const keys = [{alias:'mine', provider:'openai', models:[{id:'first', name:'local', modality:'image'}]}];
    return new Response(JSON.stringify(url.includes('borrowable-models') ? {models} : {keys}));
  });
  const imageNode: CanvasImageNode = {...node, type:'image', data:{
    current_version_id:null, active_run_id:null, generation_draft:null, display:{fit:'contain', free_resize:false},
  }};
  const properties = {node:imageNode, peerKey:'peer', projectId:'p', owner:'房主', allowBorrow:true};
  let view = render(<SharedCanvasGenerate {...properties} revision={1} />);
  fireEvent.click(screen.getByRole('button', {name:'生成…'}));
  await waitFor(() => expect(screen.getByRole('button', {name:'生成'})).toBeEnabled());
  fireEvent.mouseDown(screen.getByRole('tab', {name:'房主供应商'}), {button:0, ctrlKey:false});
  expect(screen.getByRole('tab', {name:'房主供应商'})).toHaveAttribute('aria-selected', 'true');
  fireEvent.change(screen.getByLabelText('提示词'), {target:{value:'原始提示'}});
  fireEvent.click(screen.getByRole('button', {name:'生成'}));
  await screen.findByRole('alert');
  const frozen: CanvasFrozenGeneration = {
    schema_version:1, source_kind:'shared_canvas', mode:'image', prompt:'实时结果的新默认',
    model_id:'another', provider:'openai', params:{n:3, actual_size:'4x4'}, inputs:[],
  };
  const current = <SharedCanvasGenerate {...properties} revision={8} frozen={frozen} />;
  if (reopen) {
    view.unmount();
    view = render(current);
    fireEvent.click(screen.getByRole('button', {name:'生成…'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'生成'})).toBeEnabled());
  } else {
    view.rerender(current);
  }
  expect(screen.getByRole('tab', {name:'房主供应商'})).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('combobox')).toHaveTextContent('first');
  expect(screen.getByLabelText('提示词')).toHaveValue('原始提示');
  expect(screen.getByRole('radio', {name:'1'})).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('button', {name:'生成'}));
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[1].params).toEqual({});
  await screen.findByRole('alert');
  fireEvent.change(screen.getByLabelText('提示词'), {target:{value:'另一次生成'}});
  fireEvent.click(screen.getByRole('button', {name:'生成'}));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(submissions[2].request_id).not.toBe(submissions[0].request_id);
  expect(submissions[2].params).toEqual(frozen.params);
});
