import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import * as http from '@/api/http';
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
  it('selects a provider and its highest ranked model, then shows only its models', () => {
    const first = key('主力', 'openai', 'gpt-image-2');
    const second = key('备用', 'custom', 'nano-banana');
    second.models.push({ id: 'gpt-image-2.5-flare', name: 'Flare', modality: 'image' });
    const choices = [first, second].flatMap(key => key.models.map(model => ({ key, model })));
    const onSelect = vi.fn();
    const view = render(<CanvasModelPicker choices={choices} alias="主力" model="gpt-image-2" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: '选择生成供应商' }));
    fireEvent.click(screen.getByRole('option', { name: /备用/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: second, model: second.models[1] }));
    view.rerender(<CanvasModelPicker choices={choices} alias="备用" model="gpt-image-2.5-flare" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: '选择生成模型' }));
    expect(screen.getAllByRole('option').map(item => item.getAttribute('aria-label'))).toEqual(['Flare', 'nano-banana']);
    expect(screen.queryByRole('option', { name: 'gpt-image-2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'nano-banana' }));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ key: second, model: second.models[0] }));
  });

  it('loads metrics only while open, prices one result, and omits missing metadata', async () => {
    const first = key('主力', 'openai', 'gpt-image-2');
    first.models.push({ id: 'nano-banana', name: 'Banana' }, { id: 'unknown', name: 'Unknown' });
    const request = vi.spyOn(http, 'requestJson').mockImplementation(async (url) => {
      if (url === '/api/models/durations') return { '主力:gpt-image-2': 120 } as never;
      return { '主力:gpt-image-2': 0.24, '主力:nano-banana': 0.1, '主力:unknown': null } as never;
    });
    try {
      render(<CanvasModelPicker choices={first.models.map(model => ({ key: first, model }))}
        alias="主力" model="gpt-image-2" params={{ n: 4, quality: 'high' }} onSelect={vi.fn()} />);
      expect(request).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '选择生成模型' }));
      await waitFor(() => expect(screen.getByRole('option', { name: 'gpt-image-2' })).toHaveTextContent('¥0.24'));
      expect(screen.getByRole('option', { name: 'gpt-image-2' })).toHaveTextContent('≈ 2m');
      expect(screen.getByRole('option', { name: 'Banana' })).toHaveTextContent('¥0.10');
      expect(screen.getByRole('option', { name: 'Banana' })).not.toHaveTextContent('≈');
      expect(screen.getByRole('option', { name: 'Unknown' })).toHaveTextContent(/^Unknown$/);
      const batch = request.mock.calls.find(([url]) => url === '/api/pricing/estimate-batch')!;
      expect(JSON.parse(String(batch[2]?.body))).toMatchObject({ kind: 'image', params: { n: 1, quality: 'high' } });
    } finally { request.mockRestore(); }
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
  it('does not label the default OpenRouter tier as 2K', () => {
    const props = {
      caps: imageControlCaps('openai/gpt-image-2.5-sunburst', 'openrouter'),
      model: 'openai/gpt-image-2.5-sunburst',
      onPatch: vi.fn(),
    };
    const { rerender } = render(<CanvasImageSettings {...props} params={{ size_mode: 'ratio', ratio: '16:9' }} />);
    expect(screen.getByRole('button', { name: '图片设置' })).not.toHaveTextContent('2K');
    rerender(<CanvasImageSettings {...props} params={{ size_mode: 'ratio', ratio: '16:9', resolution: '4K' }} />);
    expect(screen.getByRole('button', { name: '图片设置' })).toHaveTextContent('4K');
  });
  it('shows only direct GPT Image controls, including editable count', () => {
    render(
      <CanvasImageSettings
        caps={imageControlCaps('gpt-image-2', 'openai')}
        model="gpt-image-2"
        params={{ n: 3, ratio: '1:1', quality: 'high', size: '2048x2048' }}
        onPatch={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '图片设置' }));
    expect(screen.getByText('自定义尺寸')).toBeInTheDocument();
    expect(screen.getByText('质量')).toBeInTheDocument();
    expect(screen.getByLabelText('选择图片生成数量')).toBeInTheDocument();
    expect(screen.queryByText('分辨率')).not.toBeInTheDocument();
  });

  it('uses Seedream resolution controls without inventing quality', () => {
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
