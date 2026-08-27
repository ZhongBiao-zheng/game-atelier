import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { KeyView } from '@/api/keys';
import { imageControlCaps } from '@/lib/imageControlCaps';
import {
  CanvasAudioSettings,
  CanvasImageSettings,
  CanvasModelPicker,
  CanvasTextSettings,
} from './CanvasGenerationControls';

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

describe('CanvasTextSettings', () => {
  it('shows reasoning and candidate controls in an independent portal', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<CanvasTextSettings supportsReasoning params={{ n: 2, reasoning_effort: 'auto' }} onPatch={onPatch} />);

    const trigger = screen.getByRole('button', { name: '文本设置' });
    await user.click(trigger);
    const popover = screen.getByTestId('canvas-text-settings-popover');
    expect(popover).toHaveAttribute('data-toolbar-popover');
    expect(screen.getByLabelText('选择推理强度')).toBeInTheDocument();
    expect(screen.getByLabelText('选择文本生成数量')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '极高' }));
    expect(onPatch).toHaveBeenCalledWith({ reasoning_effort: 'xhigh' });
  });

  it('hides reasoning for chat-completions models', () => {
    const onPatch = vi.fn();
    render(<CanvasTextSettings supportsReasoning={false} params={{ n: 1 }} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: '文本设置' }));
    expect(screen.queryByLabelText('选择推理强度')).not.toBeInTheDocument();
    expect(screen.getByLabelText('选择文本生成数量')).toBeInTheDocument();
    expect(screen.getByLabelText('选择对话随机性')).toBeInTheDocument();
    expect(screen.getByLabelText('选择最大输出长度')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '均衡' }));
    fireEvent.click(screen.getByRole('option', { name: '2048' }));
    expect(onPatch).toHaveBeenNthCalledWith(1, { temperature: 0.7 });
    expect(onPatch).toHaveBeenNthCalledWith(2, { max_tokens: 2048 });
  });
});

describe('CanvasAudioSettings', () => {
  it('shows voice, format, speed and instructions in an independent portal', () => {
    const onPatch = vi.fn();
    render(<CanvasAudioSettings
      params={{ voice: 'alloy', response_format: 'mp3', speed: 1 }}
      onPatch={onPatch}
    />);

    fireEvent.click(screen.getByRole('button', { name: '音频设置' }));
    const popover = screen.getByTestId('canvas-audio-settings-popover');
    expect(popover).toHaveAttribute('data-toolbar-popover');
    expect(screen.getByLabelText('选择音色')).toBeInTheDocument();
    expect(screen.getByLabelText('选择音频格式')).toBeInTheDocument();
    expect(screen.getByLabelText('自定义语速')).toHaveValue(1);
    expect(screen.getByLabelText('朗读指令')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'Marin' }));
    fireEvent.click(screen.getByRole('option', { name: 'PCM' }));
    fireEvent.click(screen.getByRole('option', { name: '1.25x' }));
    expect(onPatch).toHaveBeenNthCalledWith(1, { voice: 'marin' });
    expect(onPatch).toHaveBeenNthCalledWith(2, { response_format: 'pcm' });
    expect(onPatch).toHaveBeenNthCalledWith(3, { speed: 1.25 });
  });

  it('commits clamped custom speed and trimmed instructions on blur', () => {
    const onPatch = vi.fn();
    render(<CanvasAudioSettings
      params={{ voice: 'alloy', response_format: 'mp3', speed: 1 }}
      onPatch={onPatch}
    />);
    fireEvent.click(screen.getByRole('button', { name: '音频设置' }));
    fireEvent.change(screen.getByLabelText('自定义语速'), { target: { value: '8' } });
    fireEvent.blur(screen.getByLabelText('自定义语速'));
    fireEvent.change(screen.getByLabelText('朗读指令'), { target: { value: '  温柔、克制  ' } });
    fireEvent.blur(screen.getByLabelText('朗读指令'));
    expect(onPatch).toHaveBeenCalledWith({ speed: 4 });
    expect(onPatch).toHaveBeenCalledWith({ instructions: '温柔、克制' });
  });

  it('commits pending fields atomically before an outside click closes the portal', () => {
    const onPatch = vi.fn();
    render(<CanvasAudioSettings
      params={{ voice: 'alloy', response_format: 'mp3', speed: 1 }}
      onPatch={onPatch}
    />);
    fireEvent.click(screen.getByRole('button', { name: '音频设置' }));
    fireEvent.change(screen.getByLabelText('自定义语速'), { target: { value: '1.35' } });
    fireEvent.change(screen.getByLabelText('朗读指令'), { target: { value: '  平静旁白  ' } });

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('canvas-audio-settings-popover')).not.toBeInTheDocument();
    expect(onPatch).toHaveBeenCalledOnce();
    expect(onPatch).toHaveBeenCalledWith({ speed: 1.35, instructions: '平静旁白' });
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
    fireEvent.click(screen.getByRole('button', { name: '图片设置' }));
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
    fireEvent.click(screen.getByRole('button', { name: '图片设置' }));
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
    fireEvent.click(screen.getByRole('button', { name: '图片设置' }));
    expect(screen.getByText('Midjourney 每次任务固定返回 4 张方案。')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择图片生成数量')).not.toBeInTheDocument();
  });
});
