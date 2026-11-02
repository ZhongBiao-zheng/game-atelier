import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkflowParameters } from './WorkflowParameters';
import { PromptInput } from './PromptInput';
import type { KeyView, WorkflowInput } from '@/api/keys';
import { canvasGenerateBlock } from '@/pages/canvasEditorModel';
import { withAutoProvider } from '@/lib/modelRoutes';
import { workflowReferenceError } from '@/lib/workflowInputs';

afterEach(cleanup);
const input: WorkflowInput = { id: 'seed', label: '种子', type: 'seed', node_id: '3',
  class_type: 'KSampler', field: 'seed', default: null, options: [], required: true };
const key: KeyView = { alias: 'local', provider: 'comfyui', base_url: 'http://127.0.0.1:8188',
  access_key: '', secret_key: null, capabilities: [], notes: '', created_at: '',
  models: [{ id: 'comfyui-upscale', name: '放大', modality: 'image', workflow_inputs: [] }] };

describe('ComfyUI generation controls', () => {
  it('closes parameters on Escape and outside clicks inside a keyboard-handling parent', async () => {
    render(<div onKeyDown={event => event.stopPropagation()}><WorkflowParameters inputs={[input]} params={{}} onPatch={vi.fn()} /></div>);
    const trigger = screen.getByRole('button', { name: '参数' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('switch'), { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('blocks missing required images and masks before submission', () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const image = { ...input, id: 'image', label: '原图', type: 'image' as const };
    const mask = { ...input, id: 'mask', label: '遮罩', type: 'mask' as const };
    const provider = { ...key, models: [{ ...key.models[0], workflow_inputs: [image] }] };
    const props = { providers: [provider], providerAlias: 'local', model: 'comfyui-upscale', onSubmit: vi.fn() };
    const { rerender } = render(<PromptInput {...props} />);
    expect(screen.getByRole('button', { name: '提交生成' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('需要参考图：原图');
    rerender(<PromptInput {...props} referenceImages={[new File(['image'], 'ref.png', { type: 'image/png' })]} />);
    expect(screen.getByRole('button', { name: '提交生成' })).toBeEnabled();
    expect(workflowReferenceError([image, mask], 1, false)).toBe('需要参考图：遮罩');
    expect(workflowReferenceError([image, mask], 1, true)).toBeNull();
  });

  it('fixing a seed also fixes the request count to one', () => {
    const patch = vi.fn();
    render(<WorkflowParameters inputs={[input]} params={{ n: 4 }} onPatch={patch} />);
    fireEvent.click(screen.getByRole('button', { name: '参数' }));
    fireEvent.click(screen.getByRole('switch'));
    expect(patch).toHaveBeenCalledWith({ workflow_inputs: { seed: 0 }, n: 1 });
  });

  it('allows empty prompts and hides image controls for a workflow without prompt input', () => {
    const submit = vi.fn();
    render(<PromptInput providers={[key]} providerAlias="local" model="comfyui-upscale" onSubmit={submit} />);
    expect(screen.getByRole('textbox', { name: '生图 prompt' })).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByRole('button', { name: '选择比例和分辨率' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交生成' }));
    expect(submit).toHaveBeenCalledWith('');
    expect(canvasGenerateBlock({ mode: 'image', modelChoiceCount: 1, keyCount: 1,
      alias: 'local', modelSelected: true, prompt: '', allowEmptyPrompt: true })).toBeNull();
  });

  it('keeps workflow declarations when creating the automatic provider', () => {
    const providers = withAutoProvider([key], [{ id: 'comfyui-upscale', name: '放大', modality: 'image', mode: 'order', candidate_alias: 'local',
      members: [{ alias: 'local', provider: 'comfyui', base_url: key.base_url, model_id: 'comfyui-upscale', name: '放大', protocol: 'comfyui' }] }]);
    expect(providers[0].models[0].workflow_inputs).toEqual([]);
  });
});
