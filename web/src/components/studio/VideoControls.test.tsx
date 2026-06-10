import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoControls } from './VideoControls';
import { videoControlCaps } from '@/lib/videoControlCaps';

const seedance = videoControlCaps('doubao-seedance-2-0-fast-260128');

function setup(overrides = {}) {
  const props = {
    caps: seedance,
    mode: 'firstlast' as const,
    duration: 5,
    resolution: '480p',
    ratio: '16:9',
    generateAudio: false,
    onModeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onResolutionChange: vi.fn(),
    onRatioChange: vi.fn(),
    onGenerateAudioChange: vi.fn(),
    ...overrides,
  };
  render(<VideoControls {...props} />);
  return props;
}

describe('VideoControls（五合一汇总按钮）', () => {
  it('collapsed button summarizes mode · ratio · resolution · duration', () => {
    setup();
    const button = screen.getByLabelText('视频生成设置');
    expect(button).toHaveTextContent('首尾帧 · 16:9 · 480p · 5s');
  });

  it('opens one popover with all five sections', () => {
    setup();
    fireEvent.click(screen.getByLabelText('视频生成设置'));
    expect(screen.getByLabelText('选择生成方式')).toBeInTheDocument();
    expect(screen.getByLabelText('选择比例')).toBeInTheDocument();
    expect(screen.getByLabelText('选择清晰度')).toBeInTheDocument();
    expect(screen.getByLabelText('选择生成时长')).toBeInTheDocument();
    expect(screen.getByLabelText('生成音频开关')).toBeInTheDocument();
  });

  it('emits onModeChange when picking 全能参考', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('视频生成设置'));
    fireEvent.click(screen.getByRole('option', { name: '全能参考' }));
    expect(props.onModeChange).toHaveBeenCalledWith('omni');
  });

  it('emits onDurationChange / onResolutionChange / onRatioChange from the panel', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('视频生成设置'));
    fireEvent.click(screen.getByRole('option', { name: '10s' }));
    expect(props.onDurationChange).toHaveBeenCalledWith(10);
    fireEvent.click(screen.getByRole('option', { name: '1080p' }));
    expect(props.onResolutionChange).toHaveBeenCalledWith('1080p');
    fireEvent.click(screen.getByRole('option', { name: /9:16/ }));
    expect(props.onRatioChange).toHaveBeenCalledWith('9:16');
  });

  it('toggles generate-audio via 开启/关闭', () => {
    const props = setup({ generateAudio: false });
    fireEvent.click(screen.getByLabelText('视频生成设置'));
    fireEvent.click(screen.getByRole('option', { name: '开启' }));
    expect(props.onGenerateAudioChange).toHaveBeenCalledWith(true);
  });

  it('hides the audio section when caps.supportsAudio is false', () => {
    setup({ caps: videoControlCaps('unknown-model') });
    fireEvent.click(screen.getByLabelText('视频生成设置'));
    expect(screen.queryByLabelText('生成音频开关')).not.toBeInTheDocument();
  });
});
