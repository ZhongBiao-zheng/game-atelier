import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { KeyView } from '@/api/keys';
import type { CanvasGenerationDefaults } from '@/schema/canvas';
import { CanvasGenerationPreferencesDialog } from './CanvasGenerationPreferencesDialog';

const EMPTY_DEFAULTS: CanvasGenerationDefaults = {
  text: { selection: null, params: {} },
  image: { selection: null, params: {} },
  video: { selection: null, params: {} },
  audio: { selection: null, params: {} },
};

function key(
  alias: string,
  provider: string,
  models: KeyView['models'],
): KeyView {
  return {
    alias,
    provider,
    base_url: null,
    access_key: '***',
    secret_key: null,
    capabilities: [],
    models,
    notes: '',
    created_at: '2026-08-25T00:00:00Z',
  };
}

const KEYS: KeyView[] = [
  key('主力图片', 'openai', [
    { id: 'gpt-image-1', name: 'GPT Image 1', modality: 'image' },
  ]),
  key('备用图片', 'seedream', [
    { id: 'seedream-5.0-lite', name: 'Seedream 5 Lite', modality: 'image', protocol: 'ark' },
  ]),
  key('未接通图片', 'nano_banana', [
    { id: 'nano-banana-pro', name: 'Nano Banana Pro', modality: 'image' },
  ]),
  key('文本', 'openai', [
    { id: 'gpt-5', name: 'GPT 5', modality: 'text', protocol: 'openai-responses' },
  ]),
];

function setup(overrides: Partial<Parameters<typeof CanvasGenerationPreferencesDialog>[0]> = {}) {
  const props: Parameters<typeof CanvasGenerationPreferencesDialog>[0] = {
    open: true,
    value: EMPTY_DEFAULTS,
    keys: KEYS,
    saving: false,
    error: null,
    onOpenChange: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  render(<CanvasGenerationPreferencesDialog {...props} />);
  return props;
}

describe('CanvasGenerationPreferencesDialog', () => {
  it('lists only Runner-routable models and saves a selected model with its params', async () => {
    const user = userEvent.setup();
    const props = setup();

    expect(screen.getByRole('dialog', { name: '生成偏好' })).toBeInTheDocument();
    expect(screen.getByText('自动选择')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '选择生成模型' }));
    expect(screen.getByRole('option', { name: 'GPT Image 1' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Seedream 5 Lite' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Nano Banana Pro' })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '生成偏好' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Seedream 5 Lite' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '选择生成模型' }));

    await user.click(screen.getByRole('option', { name: 'Seedream 5 Lite' }));
    await user.click(screen.getByRole('button', { name: '图片设置' }));
    await user.click(screen.getByRole('option', { name: '2 张' }));
    await user.click(screen.getByRole('button', { name: '保存偏好' }));

    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      image: expect.objectContaining({
        selection: { alias: '备用图片', model: 'seedream-5.0-lite' },
        params: expect.objectContaining({ n: 2, ratio: '1:1' }),
      }),
    }));
  });

  it('warns about a stale explicit model and clears stale params when saving', async () => {
    const onSave = vi.fn();
    setup({
      value: {
        ...EMPTY_DEFAULTS,
        image: {
          selection: { alias: '已删除渠道', model: 'old-model' },
          params: { n: 4, ratio: '9:16', quality: 'high' },
        },
      },
      onSave,
    });

    expect(screen.getByRole('alert')).toHaveTextContent('已保存的默认模型不再可用');
    fireEvent.click(screen.getByRole('button', { name: '保存偏好' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].image).toEqual({ selection: null, params: {} });
  });

  it('restores automatic selection and cancels without saving', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSave = vi.fn();
    setup({
      value: {
        ...EMPTY_DEFAULTS,
        image: {
          selection: { alias: '主力图片', model: 'gpt-image-1' },
          params: { n: 2, ratio: '1:1' },
        },
      },
      onOpenChange,
      onSave,
    });

    await user.click(screen.getByRole('button', { name: '恢复自动选择' }));
    expect(screen.getByText('自动选择')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps default params when automatic model selection is saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    setup({ onSave });

    await user.click(screen.getByRole('button', { name: '图片设置' }));
    await user.click(screen.getByRole('option', { name: '2 张' }));
    await user.click(screen.getByRole('button', { name: '保存偏好' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      image: {
        selection: null,
        params: expect.objectContaining({ n: 2, ratio: '1:1' }),
      },
    }));
  });
});
