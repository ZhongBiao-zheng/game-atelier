import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoControls } from './VideoControls';
import { videoControlCaps } from '@/lib/videoControlCaps';

const seedance = videoControlCaps('doubao-seedance-2-0-fast-260128');

function setupProps(overrides = {}) {
  return {
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
}

function setup(overrides = {}) {
  const props = setupProps(overrides);
  render(<VideoControls {...props} />);
  return props;
}

describe('VideoControls（五合一汇总按钮）', () => {
  it('shows a watermark section only when the model and caller support it', () => {
    const onWatermarkChange = vi.fn();
    const { rerender } = render(
      <VideoControls
        {...setupProps()}
        caps={{ ...seedance, supportsWatermark: true }}
        watermark={false}
        onWatermarkChange={onWatermarkChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '视频设置' }));
    expect(screen.getByText('视频水印')).toBeInTheDocument();
    const section = screen.getByText('视频水印').closest('section')!;
    fireEvent.click(section.querySelectorAll('[role="option"]')[0]);
    expect(onWatermarkChange).toHaveBeenCalledWith(true);

    rerender(<VideoControls {...setupProps()} caps={{ ...seedance, supportsWatermark: false }} />);
    expect(screen.queryByText('视频水印')).not.toBeInTheDocument();
  });
  it('collapsed button summarizes mode · ratio · resolution · duration', () => {
    setup();
    const button = screen.getByLabelText('视频设置');
    expect(button).toHaveTextContent('首尾帧 · 16:9 · 480p · 5s');
  });

  it('opens one popover with all five sections', () => {
    setup();
    fireEvent.click(screen.getByLabelText('视频设置'));
    expect(screen.getByLabelText('选择生成方式')).toBeInTheDocument();
    expect(screen.getByLabelText('选择比例')).toBeInTheDocument();
    expect(screen.getByLabelText('选择清晰度')).toBeInTheDocument();
    expect(screen.getByLabelText('选择生成时长')).toBeInTheDocument();
    expect(screen.getByLabelText('生成音频开关')).toBeInTheDocument();
  });

  it('emits onModeChange when picking 全能参考', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('视频设置'));
    fireEvent.click(screen.getByRole('option', { name: '全能参考' }));
    expect(props.onModeChange).toHaveBeenCalledWith('omni');
  });

  it('emits onDurationChange / onResolutionChange / onRatioChange from the panel', () => {
    // 2.0-fast 官方无 1080p，分辨率断言用非 fast 的 seedance-2.0 caps。
    const props = setup({ caps: videoControlCaps('seedance-2.0') });
    fireEvent.click(screen.getByLabelText('视频设置'));
    fireEvent.click(screen.getByRole('option', { name: '10s' }));
    expect(props.onDurationChange).toHaveBeenCalledWith(10);
    fireEvent.click(screen.getByRole('option', { name: '1080p' }));
    expect(props.onResolutionChange).toHaveBeenCalledWith('1080p');
    fireEvent.click(screen.getByRole('option', { name: /9:16/ }));
    expect(props.onRatioChange).toHaveBeenCalledWith('9:16');
  });

  it('seedance 2.0 panel exposes the official 4-15s duration range and adaptive ratio', () => {
    setup({ caps: videoControlCaps('seedance-2.0') });
    fireEvent.click(screen.getByLabelText('视频设置'));
    expect(screen.getByRole('option', { name: '4s' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '15s' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /自适应/ })).toBeInTheDocument();
  });

  it('hides ratio/duration sections when the family has no such params (happyhorse video-edit)', () => {
    setup({ caps: videoControlCaps('happyhorse-1.0-video-edit'), mode: 'omni' as const });
    fireEvent.click(screen.getByLabelText('视频设置'));
    expect(screen.queryByLabelText('选择比例')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择生成时长')).not.toBeInTheDocument();
    expect(screen.getByLabelText('选择清晰度')).toBeInTheDocument();
  });

  it('toggles generate-audio via 开启/关闭', () => {
    const props = setup({ generateAudio: false });
    fireEvent.click(screen.getByLabelText('视频设置'));
    fireEvent.click(screen.getByRole('option', { name: '开启' }));
    expect(props.onGenerateAudioChange).toHaveBeenCalledWith(true);
  });

  it('hides the audio section when caps.supportsAudio is false', () => {
    setup({ caps: videoControlCaps('unknown-model') });
    fireEvent.click(screen.getByLabelText('视频设置'));
    expect(screen.queryByLabelText('生成音频开关')).not.toBeInTheDocument();
  });
});
