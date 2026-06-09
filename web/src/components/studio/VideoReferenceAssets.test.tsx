import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoReferenceAssets } from './VideoReferenceAssets';
import { videoControlCaps } from '@/lib/videoControlCaps';

const seedance = videoControlCaps('doubao-seedance-2-0-fast-260128');

function setup(overrides = {}) {
  const props = {
    caps: seedance,
    mode: 'i2v' as const,
    frameMode: 'auto' as const,
    images: [] as File[],
    videos: [] as File[],
    audios: [] as File[],
    onImagesChange: vi.fn(),
    onVideosChange: vi.fn(),
    onAudiosChange: vi.fn(),
    ...overrides,
  };
  render(<VideoReferenceAssets {...props} />);
  return props;
}

describe('VideoReferenceAssets', () => {
  it('renders nothing in t2v mode', () => {
    const { container } = render(
      <VideoReferenceAssets
        caps={seedance} mode="t2v" frameMode="auto"
        images={[]} videos={[]} audios={[]}
        onImagesChange={vi.fn()} onVideosChange={vi.fn()} onAudiosChange={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a single 源图 slot for i2v auto', () => {
    setup({ mode: 'i2v', frameMode: 'auto' });
    expect(screen.getByLabelText('上传源图')).toBeInTheDocument();
    expect(screen.queryByLabelText('上传末帧')).not.toBeInTheDocument();
  });

  it('shows ordered 首帧 + 末帧 slots for i2v firstlast', () => {
    setup({ mode: 'i2v', frameMode: 'firstlast' });
    expect(screen.getByLabelText('上传首帧')).toBeInTheDocument();
    expect(screen.getByLabelText('上传末帧')).toBeInTheDocument();
  });

  it('shows image + video + audio groups for ref mode', () => {
    setup({ mode: 'ref' });
    expect(screen.getByLabelText('上传参考图')).toBeInTheDocument();
    expect(screen.getByLabelText('上传参考视频')).toBeInTheDocument();
    expect(screen.getByLabelText('上传参考音频')).toBeInTheDocument();
  });

  it('shows a 视频底 slot for v2v mode', () => {
    setup({ mode: 'v2v' });
    expect(screen.getByLabelText('上传视频底')).toBeInTheDocument();
  });

  it('hides video/audio groups when caps do not support them', () => {
    setup({ mode: 'ref', caps: videoControlCaps('unknown-model') });
    expect(screen.queryByLabelText('上传参考视频')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('上传参考音频')).not.toBeInTheDocument();
  });
});
