import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { KeyView } from '@/api/keys';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { CanvasCountSettings, CanvasImageSettings, CanvasModelPicker } from './CanvasGenerationControls';

function key(alias: string, provider: string, model: string): KeyView {
  return {
    alias,
    provider,
    base_url: null,
    access_key: '***',
    secret_key: null,
    capabilities: [],
    models: [{ id: model, name: model, modality: 'image' }],
    notes: '',
    created_at: '2026-08-25T00:00:00Z',
  };
}

describe('CanvasModelPicker', () => {
  it('opens a portal popover grouped by key and selects the whole key/model pair', () => {
    const first = key('主力', 'openai', 'gpt-image-2');
    const second = key('备用', 'seedream', 'seedream-5.0-lite');
    const onSelect = vi.fn();
    render(
      <CanvasModelPicker
        choices={[
          { key: first, model: first.models[0] },
          { key: second, model: second.models[0] },
        ]}
        alias="主力"
        model="gpt-image-2"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '选择生成模型' }));
    const popover = screen.getByTestId('canvas-model-popover');
    expect(popover).toHaveAttribute('data-toolbar-popover');
    expect(popover).toHaveTextContent('主力 · openai');
    fireEvent.click(screen.getByRole('option', { name: 'seedream-5.0-lite' }));
    expect(onSelect).toHaveBeenCalledWith({ key: second, model: second.models[0] });
  });

  it('moves focus into the portal and returns it to the trigger after Escape', async () => {
    const first = key('主力', 'openai', 'gpt-image-2');
    render(
      <CanvasModelPicker
        choices={[{ key: first, model: first.models[0] }]}
        alias="主力"
        model="gpt-image-2"
        onSelect={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: '选择生成模型' });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('option', { name: 'gpt-image-2' })).toHaveFocus());

    fireEvent.keyDown(screen.getByTestId('canvas-model-popover'), { key: 'Escape' });
    expect(screen.queryByTestId('canvas-model-popover')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('returns focus after choosing a model with Enter', async () => {
    const user = userEvent.setup();
    const first = key('主力', 'openai', 'gpt-image-2');
    const onSelect = vi.fn();
    render(
      <CanvasModelPicker
        choices={[{ key: first, model: first.models[0] }]}
        alias={null}
        model=""
        onSelect={onSelect}
      />,
    );

    const trigger = screen.getByRole('button', { name: '选择生成模型' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('option', { name: 'gpt-image-2' })).toHaveFocus());
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('canvas-model-popover')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('CanvasCountSettings', () => {
  it('returns focus after choosing a candidate count with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CanvasCountSettings value={2} onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: '文本生成设置' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('option', { name: '1 个' })).toHaveFocus());
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith(1);
    expect(screen.queryByLabelText('选择文本生成数量')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('CanvasImageSettings', () => {
  it('shows only direct GPT Image controls, including transparency and editable count', () => {
    render(
      <CanvasImageSettings
        caps={imageControlCaps('gpt-image-2', 'openai')}
        model="gpt-image-2"
        params={{ n: 3, ratio: '1:1', quality: 'high', size: '2048x2048' }}
        onPatch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开图片参数' }));
    expect(screen.getByText('透明背景')).toBeInTheDocument();
    expect(screen.getByText('自定义尺寸')).toBeInTheDocument();
    expect(screen.getByText('质量')).toBeInTheDocument();
    expect(screen.getByLabelText('选择图片生成数量')).toBeInTheDocument();
    expect(screen.queryByText('分辨率')).not.toBeInTheDocument();
  });

  it('uses Seedream resolution controls without inventing quality or transparency', () => {
    render(
      <CanvasImageSettings
        caps={imageControlCaps('seedream-5.0-lite', 'seedream')}
        model="seedream-5.0-lite"
        params={{ n: 1, ratio: '16:9', resolution: '2K', size: '2560x1440' }}
        onPatch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开图片参数' }));
    expect(screen.getByText('分辨率')).toBeInTheDocument();
    expect(screen.getByText('自定义尺寸')).toBeInTheDocument();
    expect(screen.queryByText('质量')).not.toBeInTheDocument();
    expect(screen.queryByText('透明背景')).not.toBeInTheDocument();
  });

  it('explains Midjourney fixed outputs instead of rendering a fake count control', () => {
    render(
      <CanvasImageSettings
        caps={imageControlCaps('midjourney-v7', 'custom')}
        model="midjourney-v7"
        params={{ n: 4, ratio: '1:1' }}
        onPatch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开图片参数' }));
    expect(screen.getByText('Midjourney 每次任务固定返回 4 张方案。')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择图片生成数量')).not.toBeInTheDocument();
  });
});
