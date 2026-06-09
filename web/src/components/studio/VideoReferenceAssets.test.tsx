import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { VideoReferenceAssets } from './VideoReferenceAssets';
import { videoControlCaps } from '@/lib/videoControlCaps';

const seedance = videoControlCaps('doubao-seedance-2-0-fast-260128');

beforeAll(() => {
  if (!URL.createObjectURL) {
    (URL as any).createObjectURL = () => 'blob:stub';
    (URL as any).revokeObjectURL = () => {};
  }
});

/** label[aria-label] → 通过 htmlFor 找到对应的 file input。 */
function inputFor(labelText: string): HTMLInputElement | null {
  const label = screen.getByLabelText(labelText);
  const id = label.getAttribute('for');
  return id ? document.getElementById(id) as HTMLInputElement | null : null;
}

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

  it('writes 首帧 to index 0 and 末帧 to index 1 (ordered), and gates 末帧 until 首帧 exists', () => {
    const onImagesChange = vi.fn();
    const { rerender } = render(
      <VideoReferenceAssets
        caps={seedance} mode="i2v" frameMode="firstlast"
        images={[]} videos={[]} audios={[]}
        onImagesChange={onImagesChange} onVideosChange={vi.fn()} onAudiosChange={vi.fn()}
      />,
    );

    // Gate: 末帧 slot is present + labeled but has NO working file input while 首帧 empty.
    expect(screen.getByLabelText('上传末帧')).toBeInTheDocument();
    expect(inputFor('上传末帧')).toBeNull();

    // Picking 首帧 on empty state → onImagesChange([firstFile]) at index 0.
    const firstInput = inputFor('上传首帧');
    expect(firstInput).not.toBeNull();
    const firstFile = new File(['x'], 'first.png', { type: 'image/png' });
    fireEvent.change(firstInput!, { target: { files: [firstFile] } });
    expect(onImagesChange).toHaveBeenCalledTimes(1);
    expect(onImagesChange.mock.calls[0][0]).toEqual([firstFile]);

    // Now 首帧 filled → 末帧 slot gains a working input; pick writes index 1, no hole.
    onImagesChange.mockClear();
    rerender(
      <VideoReferenceAssets
        caps={seedance} mode="i2v" frameMode="firstlast"
        images={[firstFile]} videos={[]} audios={[]}
        onImagesChange={onImagesChange} onVideosChange={vi.fn()} onAudiosChange={vi.fn()}
      />,
    );
    const lastInput = inputFor('上传末帧');
    expect(lastInput).not.toBeNull();
    const lastFile = new File(['y'], 'last.png', { type: 'image/png' });
    fireEvent.change(lastInput!, { target: { files: [lastFile] } });
    expect(onImagesChange).toHaveBeenCalledTimes(1);
    const result = onImagesChange.mock.calls[0][0] as File[];
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(firstFile);
    expect(result[1]).toBe(lastFile);
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
