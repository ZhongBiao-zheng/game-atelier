import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { PromptInput } from './PromptInput';
import type { KeyView } from '@/api/keys';

const hkKey: KeyView = {
  alias: 'hk',
  provider: 'custom',
  base_url: 'https://api.openai-hk.com',
  access_key: 'hk...key',
  secret_key: null,
  capabilities: ['portrait'],
  models: [
    { name: 'GPT Image 2', id: 'gpt-image-2' },
    { name: 'Nano Banana', id: 'nano-banana' },
  ],
  notes: '',
  created_at: '2026-05-25T00:00:00Z',
  is_default: true,
};

function renderWith(model: string) {
  return render(
    <PromptInput
      onSubmit={vi.fn()}
      providers={[hkKey]}
      providerAlias="hk"
      model={model}
    />,
  );
}

describe('PromptInput 尺寸面板按模型族渲染', () => {
  it('gpt-image: 显示自定义尺寸 + 质量，不显示分辨率', () => {
    renderWith('gpt-image-2');
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByLabelText('输出宽度')).toBeInTheDocument();
    expect(screen.getByLabelText('选择质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择分辨率')).not.toBeInTheDocument();
    cleanup();
  });

  it('nano-banana: 仅显示质量，不显示分辨率/自定义尺寸', () => {
    renderWith('nano-banana');
    fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
    expect(screen.getByLabelText('选择质量')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择分辨率')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('输出宽度')).not.toBeInTheDocument();
    cleanup();
  });
});

// --- video mode ---
import { videoControlCaps } from '@/lib/videoControlCaps';

const videoKey = {
  alias: 'ark', provider: 'seedance', base_url: null, access_key: '***', secret_key: null,
  capabilities: [], models: [{ name: 'Seedance', id: 'doubao-seedance-2-0-fast-260128' }],
  modalities: ['video'], notes: '', created_at: '', is_default: false,
};

function renderVideoMode(overrides = {}) {
  const onModeChange = vi.fn();
  render(
    <PromptInput
      onSubmit={vi.fn()}
      providers={[videoKey as any]}
      providerAlias="ark"
      model="doubao-seedance-2-0-fast-260128"
      kind="video"
      onKindChange={vi.fn()}
      videoMode="firstlast"
      videoCaps={videoControlCaps('doubao-seedance-2-0-fast-260128')}
      duration={5}
      videoResolution="720p"
      videoRatio="16:9"
      generateAudio={false}
      onVideoModeChange={onModeChange}
      onDurationChange={vi.fn()}
      onVideoResolutionChange={vi.fn()}
      onVideoRatioChange={vi.fn()}
      onGenerateAudioChange={vi.fn()}
      referenceVideos={[]}
      referenceAudios={[]}
      onReferenceVideosChange={vi.fn()}
      onReferenceAudiosChange={vi.fn()}
      referenceImages={[]}
      onReferenceImagesChange={vi.fn()}
      videoFrames={{ first: null, last: null }}
      onVideoFramesChange={vi.fn()}
      {...overrides}
    />,
  );
  return { onModeChange };
}

describe('PromptInput video mode', () => {
  it('renders the combined video settings button in video kind', () => {
    renderVideoMode();
    expect(screen.getByLabelText('视频生成设置')).toBeInTheDocument();
    cleanup();
  });

  it('does not render the image size control in video kind', () => {
    renderVideoMode();
    expect(screen.queryByLabelText('选择比例和分辨率')).not.toBeInTheDocument();
    cleanup();
  });

  it('renders 首尾帧 slots left of the textarea in firstlast mode', () => {
    renderVideoMode({ videoMode: 'firstlast' });
    expect(screen.getByLabelText('上传首帧')).toBeInTheDocument();
    expect(screen.getByLabelText('上传尾帧')).toBeInTheDocument();
    expect(screen.getByLabelText('互换首尾帧')).toBeInTheDocument();
    cleanup();
  });

  it('renders omni reference asset groups in omni mode', () => {
    renderVideoMode({ videoMode: 'omni' });
    expect(screen.getByLabelText('上传参考图')).toBeInTheDocument();
    expect(screen.queryByLabelText('上传首帧')).not.toBeInTheDocument();
    cleanup();
  });

  it('kind button opens a popover and selecting 图片生成 emits onKindChange', () => {
    const onKindChange = vi.fn();
    renderVideoMode({ onKindChange });
    fireEvent.click(screen.getByLabelText('选择生成模式'));
    fireEvent.click(screen.getByRole('option', { name: /图片生成/ }));
    expect(onKindChange).toHaveBeenCalledWith('image');
    cleanup();
  });
});

describe('PromptInput 模型按分类过滤（模型级 modality 优先，key 级兜底）', () => {
  const mixedKey: KeyView = {
    ...hkKey,
    alias: 'mixed',
    base_url: 'https://api.example.com',
    models: [
      { name: 'GPT Image 2', id: 'gpt-image-2', modality: 'image' },
      { name: 'Sora 2', id: 'sora-2', modality: 'video' },
    ],
    modalities: ['image', 'video'],
  };

  it('图片模式只列出图片模型', () => {
    render(
      <PromptInput onSubmit={vi.fn()} providers={[mixedKey]} providerAlias="mixed" model="gpt-image-2" />,
    );
    fireEvent.click(screen.getByLabelText('选择模型'));
    expect(screen.getByRole('option', { name: /GPT Image 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Sora 2/ })).not.toBeInTheDocument();
    cleanup();
  });

  it('视频模式只列出视频模型，混挂 key 仍可见', () => {
    renderVideoMode({ providers: [mixedKey as any], providerAlias: 'mixed', model: 'sora-2' });
    fireEvent.click(screen.getByLabelText('选择模型'));
    expect(screen.getByRole('option', { name: /Sora 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /GPT Image 2/ })).not.toBeInTheDocument();
    cleanup();
  });

  it('未标注模型按 key 级 modalities 兜底（纯 video key 在视频模式可见）', () => {
    renderVideoMode();
    fireEvent.click(screen.getByLabelText('选择模型'));
    expect(screen.getByRole('option', { name: /Seedance/ })).toBeInTheDocument();
    cleanup();
  });
});

describe('PromptInput 消耗提示（仅 OpenAI-HK 聚合商，人民币无单位无汉字）', () => {
  it('hk + gpt-image-2 低质量 ×3 → 0.18', () => {
    render(
      <PromptInput onSubmit={vi.fn()} providers={[hkKey]} providerAlias="hk" model="gpt-image-2" quality="low" count={3} />,
    );
    const hint = screen.getByTestId('credit-cost-hint');
    expect(hint).toHaveTextContent('0.18');
    expect(hint.textContent).not.toMatch(/[一-龥¥]/);
    cleanup();
  });

  it('未定价档位（nano-banana 高质量）不显示', () => {
    render(
      <PromptInput onSubmit={vi.fn()} providers={[hkKey]} providerAlias="hk" model="nano-banana" quality="high" />,
    );
    expect(screen.queryByTestId('credit-cost-hint')).toBeNull();
    cleanup();
  });

  it('非 hk 厂商不显示', () => {
    const otherKey = { ...hkKey, base_url: 'https://api.example.com' };
    render(
      <PromptInput onSubmit={vi.fn()} providers={[otherKey]} providerAlias="hk" model="gpt-image-2" quality="low" />,
    );
    expect(screen.queryByTestId('credit-cost-hint')).toBeNull();
    cleanup();
  });

  it('视频模式（ark key 无价目）不显示', () => {
    renderVideoMode({ count: 4 });
    expect(screen.queryByTestId('credit-cost-hint')).toBeNull();
    cleanup();
  });
});
