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
      videoMode="i2v"
      videoCaps={videoControlCaps('doubao-seedance-2-0-fast-260128')}
      duration={5}
      videoResolution="720p"
      videoRatio="16:9"
      frameMode="auto"
      generateAudio={false}
      onVideoModeChange={onModeChange}
      onDurationChange={vi.fn()}
      onVideoResolutionChange={vi.fn()}
      onVideoRatioChange={vi.fn()}
      onFrameModeChange={vi.fn()}
      onGenerateAudioChange={vi.fn()}
      referenceVideos={[]}
      referenceAudios={[]}
      onReferenceVideosChange={vi.fn()}
      onReferenceAudiosChange={vi.fn()}
      referenceImages={[]}
      onReferenceImagesChange={vi.fn()}
      {...overrides}
    />,
  );
  return { onModeChange };
}

describe('PromptInput video mode', () => {
  it('renders the video control row (mode selector) in video kind', () => {
    renderVideoMode();
    expect(screen.getByLabelText('选择视频模式')).toBeInTheDocument();
  });

  it('does not render the image size control in video kind', () => {
    renderVideoMode();
    expect(screen.queryByLabelText('选择比例和分辨率')).not.toBeInTheDocument();
  });

  it('renders the video reference asset slot for i2v', () => {
    renderVideoMode({ videoMode: 'i2v', frameMode: 'auto' });
    expect(screen.getByLabelText('上传源图')).toBeInTheDocument();
  });

  it('clicking the kind pill toggles to image', () => {
    const onKindChange = vi.fn();
    renderVideoMode({ onKindChange });
    fireEvent.click(screen.getByLabelText('切换到图片生成'));
    expect(onKindChange).toHaveBeenCalledWith('image');
  });
});
