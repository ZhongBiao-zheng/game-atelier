import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KeyView, WorkflowInput } from '@/api/keys';
import type { CanvasImageEditNode, CanvasMediaVersion } from '@/schema/canvas';
import { CanvasInpaintEditor } from './CanvasInpaintEditor';
import type { CanvasMaskEditSubmission } from './ImageEditorShell';
import { savedImageEditError, editModelChoices } from './imageEditGeometry';
import { modelDisplayName } from '@/lib/modelCatalog';

vi.mock('./imageEditGeometry', async importOriginal => ({
  ...await importOriginal<typeof import('./imageEditGeometry')>(),
  drawEditStrokes: vi.fn(),
  editMaskBlob: vi.fn(async () => new Blob(['mask'], { type: 'image/png' })),
}));

const keys = [
  { alias: 'Evo', provider: 'evolink', models: [{ id: 'mj-v8.2', modality: 'image' }] },
  { alias: 'HK', provider: 'custom', base_url: 'https://api.openai-hk.com',
    models: [{ id: 'gpt-image-2.5-flare', name: 'GPT Flare', modality: 'image' }] },
  { alias: 'Tuzi', provider: 'custom', base_url: 'https://api.tu-zi.com',
    models: [{ id: 'nano-banana-2', name: 'Nano Banana 2', modality: 'image' }] },
] as KeyView[];
const source = { version_id: 'source', kind: 'image', width: 1024, height: 1024 } as CanvasMediaVersion;
const initial: CanvasImageEditNode['data'] = {
  source_version_id: 'source', source_node_id: 'source-node', mask_version_id: 'mask',
  reference_node_id: null, reference_version_id: null, active_run_id: null,
  generation_draft: { mode: 'image', alias: 'HK', model: 'gpt-image-2.5-flare', prompt: '改成蓝色',
    input_policy: 'all_connected', params: { n: 2, quality: 'low' }, updated_at: '' },
  options: { mode: 'inpaint' }, editor_state: { frame_ratio: '',
    frame: { width: 1024, height: 1024, x: 0, y: 0 },
    strokes: [{ tool: 'brush', size: 64, points: [{ x: 512, y: 512 }] }],
  },
};
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

function mount(data = initial, available = keys) {
  const onOpenChange = vi.fn();
  const save = vi.fn(async (_submission: CanvasMaskEditSubmission) => true);
  const submit = vi.fn(async (_submission: CanvasMaskEditSubmission) => true);
  render(<CanvasInpaintEditor open title="测试图" mediaUrl="/fixture.png" version={source} keys={available}
    initialData={data} busy={false} error={null} onOpenChange={onOpenChange} onSave={save} onSubmit={submit} />);
  const image = screen.getByAltText('测试图');
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
  fireEvent.load(image);
  return { save, submit, onOpenChange };
}
async function select(name: RegExp) {
  const provider = keys.find(key => key.models.some(model => name.test(modelDisplayName(model))))!;
  fireEvent.click(screen.getByRole('button', { name: '选择生成供应商' }));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(provider.alias) }));
  fireEvent.click(screen.getByRole('button', { name: '选择生成模型' }));
  fireEvent.click(await screen.findByRole('option', { name }));
}

it('restores and submits regular editing with fixed source size and mask', async () => {
  const { submit } = mount();
  expect(screen.getByRole('button', { name: '选择生成模型' })).toHaveTextContent('GPT Flare');
  fireEvent.click(screen.getByRole('button', { name: /生成 2 张/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][0]).toMatchObject({ requestedCount: 2, options: { mode: 'inpaint' },
    draft: { alias: 'HK', model: 'gpt-image-2.5-flare', params: { n: 2, size: '1024x1024', size_mode: 'custom', quality: 'low' } },
    editorState: { strokes: initial.editor_state.strokes } });
});

it('switches MJ and normal models without losing strokes or sending stale size fields', async () => {
  const { save } = mount();
  await select(/Midjourney/);
  expect(screen.queryByRole('button', { name: '生成数量' })).not.toBeInTheDocument();
  expect(screen.getByText('4 张 · Fast')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0]).toMatchObject({ requestedCount: 4, draft: { alias: 'Evo', params: { n: 4 } } });
  expect(save.mock.calls[0][0].draft.params).toEqual({ n: 4 });
  await select(/Nano Banana 2/);
  expect(screen.getByRole('button', { name: '生成数量' })).toHaveTextContent('2 张');
  fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0]).toMatchObject({ requestedCount: 2,
    draft: { model: 'nano-banana-2', prompt: '改成蓝色', params: { size: '1:1', size_mode: 'ratio' } },
    editorState: { strokes: initial.editor_state.strokes } });
});

it('allows natural repair for normal models but requires MJ prompt', async () => {
  mount({ ...initial, generation_draft: { ...initial.generation_draft!, prompt: '' } });
  expect(screen.getByRole('button', { name: /生成 2 张/ })).toBeEnabled();
  await select(/Midjourney/);
  expect(screen.getByRole('button', { name: /生成 4 张/ })).toBeDisabled();
});

it('never silently substitutes a missing saved model', () => {
  mount(initial, [keys[0]]);
  expect(screen.getByRole('button', { name: '选择生成模型' })).toHaveTextContent('选择模型');
  expect(screen.getByRole('button', { name: /生成 2 张/ })).toBeDisabled();
});

it('validates saved regular edit nodes without requiring MJ', () => {
  const node = { data: initial } as CanvasImageEditNode;
  expect(savedImageEditError(node, source, keys)).toBeNull();
  expect(savedImageEditError({ ...node, data: { ...initial, mask_version_id: null } }, source, keys)).toContain('区域');
});

const workflowInputs = ['image', 'mask', 'seed', 'float'].map((type, i) => ({
  id: type, type, label: type === 'float' ? '重绘幅度' : type,
  node_id: String(i), class_type: 'Test', field: type, default: type === 'float' ? 0.5 : null,
  required: true, min: 0, max: 100, step: 1, options: [],
})) as WorkflowInput[];
const workflowKey = { ...keys[1], alias: 'Hub', provider: 'atelier', models: [
  { id: 'comfyui-inpaint', name: '工作流重绘', modality: 'image', workflow_inputs: workflowInputs },
] } as KeyView;

it('uses independent mask workflow parameters, permits no prompt, and locks fixed seed to one image', async () => {
  const { submit } = mount({ ...initial, generation_draft: { ...initial.generation_draft!, alias: 'Hub',
    model: 'comfyui-inpaint', prompt: '', params: { n: 3, workflow_inputs: { seed: 42, float: 0.35 } } },
  }, [workflowKey]);
  expect(screen.getByRole('textbox', { name: '编辑提示词' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '生成数量' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '分辨率' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '参数' }));
  expect(screen.getByLabelText('重绘幅度', { selector: 'input' })).toHaveValue(0.35);
  fireEvent.keyDown(screen.getByLabelText('重绘幅度', { selector: 'input' }), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /生成 1 张/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][0]).toMatchObject({ requestedCount: 1, referenceVersionId: null,
    draft: { prompt: '', params: { n: 1, workflow_inputs: { seed: 42, float: 0.35 } } } });
  expect(submit.mock.calls[0][0].draft.params).not.toHaveProperty('size');
});

it('only offers one-image one-mask workflows for inpaint and excludes them from outpaint', () => {
  expect(editModelChoices([workflowKey])).toHaveLength(1);
  expect(editModelChoices([workflowKey], 'outpaint')).toHaveLength(0);
  for (const inputs of [workflowInputs.filter(i => i.type !== 'mask'),
    [...workflowInputs, { ...workflowInputs[0], id: 'image2' }]]) {
    expect(editModelChoices([{ ...workflowKey, models: [{ ...workflowKey.models[0], workflow_inputs: inputs }] }])).toHaveLength(0);
  }
});


it('Escape closes the model menu without saving or closing the editor', async () => {
  const { save, onOpenChange } = mount();
  fireEvent.click(screen.getByRole('button', { name: '选择生成模型' }));
  const option = await screen.findByRole('option', { name: 'GPT Flare' });
  fireEvent.keyDown(option, { key: 'Escape' });
  expect(screen.queryByTestId('canvas-model-popover')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '选择生成模型' })).toHaveFocus();
});
