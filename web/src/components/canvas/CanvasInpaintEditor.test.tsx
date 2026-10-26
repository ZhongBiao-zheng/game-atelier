import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { CanvasImageEditNode, CanvasMediaVersion } from '@/schema/canvas';
import { CanvasInpaintEditor } from './CanvasInpaintEditor';
import type { CanvasMaskEditSubmission } from './ImageEditorShell';
import { savedImageEditError } from './imageEditGeometry';

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
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
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
  const provider = keys.find(key => key.models.some(model => name.test(model.name || model.id)))!;
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
  await select(/mj-v8\.2/);
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
  await select(/mj-v8\.2/);
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
