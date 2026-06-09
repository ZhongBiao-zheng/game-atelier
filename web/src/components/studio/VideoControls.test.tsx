import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoControls } from './VideoControls';
import { videoControlCaps } from '@/lib/videoControlCaps';

const seedance = videoControlCaps('doubao-seedance-2-0-fast-260128');

function setup(overrides = {}) {
  const props = {
    caps: seedance,
    mode: 'i2v' as const,
    duration: 5,
    resolution: '720p',
    ratio: '16:9',
    frameMode: 'auto' as const,
    generateAudio: false,
    onModeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onResolutionChange: vi.fn(),
    onRatioChange: vi.fn(),
    onFrameModeChange: vi.fn(),
    onGenerateAudioChange: vi.fn(),
    ...overrides,
  };
  render(<VideoControls {...props} />);
  return props;
}

describe('VideoControls', () => {
  it('opens the mode menu and emits onModeChange', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('选择视频模式'));
    fireEvent.click(screen.getByRole('option', { name: /参考生视频/ }));
    expect(props.onModeChange).toHaveBeenCalledWith('ref');
  });

  it('shows the frame-mode control only in i2v mode', () => {
    setup({ mode: 'i2v' });
    expect(screen.getByLabelText('选择帧模式')).toBeInTheDocument();
  });

  it('hides the frame-mode control outside i2v', () => {
    setup({ mode: 't2v' });
    expect(screen.queryByLabelText('选择帧模式')).not.toBeInTheDocument();
  });

  it('emits onDurationChange from the duration menu', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('选择时长'));
    fireEvent.click(screen.getByRole('option', { name: '10s' }));
    expect(props.onDurationChange).toHaveBeenCalledWith(10);
  });

  it('toggles generate-audio when supported', () => {
    const props = setup({ generateAudio: false });
    fireEvent.click(screen.getByLabelText('生成音频'));
    expect(props.onGenerateAudioChange).toHaveBeenCalledWith(true);
  });

  it('hides the audio toggle when caps.supportsAudio is false', () => {
    setup({ caps: videoControlCaps('unknown-model') });
    expect(screen.queryByLabelText('生成音频')).not.toBeInTheDocument();
  });
});
