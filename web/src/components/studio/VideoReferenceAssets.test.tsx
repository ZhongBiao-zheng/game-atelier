import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FirstLastFrames, VideoReferenceAssets } from './VideoReferenceAssets';
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

describe('FirstLastFrames（首尾帧双 slot）', () => {
  it('renders 首帧 + 尾帧 slots with a swap button, 语义标注在槽位内', () => {
    render(<FirstLastFrames frames={{ first: null, last: null }} onChange={vi.fn()} />);
    expect(screen.getByLabelText('上传首帧')).toHaveTextContent('首帧');
    expect(screen.getByLabelText('上传尾帧')).toHaveTextContent('尾帧');
    expect(screen.getByLabelText('互换首尾帧')).toBeInTheDocument();
  });

  it('没有首帧也能传尾帧（无门控），写入 last 槽', () => {
    const onChange = vi.fn();
    render(<FirstLastFrames frames={{ first: null, last: null }} onChange={onChange} />);
    const lastInput = inputFor('上传尾帧');
    expect(lastInput).not.toBeNull();
    const lastFile = new File(['y'], 'last.png', { type: 'image/png' });
    fireEvent.change(lastInput!, { target: { files: [lastFile] } });
    expect(onChange).toHaveBeenCalledWith({ first: null, last: lastFile });
  });

  it('首帧写入 first 槽', () => {
    const onChange = vi.fn();
    render(<FirstLastFrames frames={{ first: null, last: null }} onChange={onChange} />);
    const firstFile = new File(['x'], 'first.png', { type: 'image/png' });
    fireEvent.change(inputFor('上传首帧')!, { target: { files: [firstFile] } });
    expect(onChange).toHaveBeenCalledWith({ first: firstFile, last: null });
  });

  it('互换按钮：全空禁用，单帧可换位到另一槽，双帧互换', () => {
    const onChange = vi.fn();
    const firstFile = new File(['x'], 'first.png', { type: 'image/png' });
    const lastFile = new File(['y'], 'last.png', { type: 'image/png' });

    const { rerender } = render(
      <FirstLastFrames frames={{ first: null, last: null }} onChange={onChange} />,
    );
    expect(screen.getByLabelText('互换首尾帧')).toBeDisabled();

    rerender(<FirstLastFrames frames={{ first: firstFile, last: null }} onChange={onChange} />);
    const swap = screen.getByLabelText('互换首尾帧');
    expect(swap).toBeEnabled();
    fireEvent.click(swap);
    expect(onChange).toHaveBeenCalledWith({ first: null, last: firstFile });

    rerender(<FirstLastFrames frames={{ first: firstFile, last: lastFile }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('互换首尾帧'));
    expect(onChange).toHaveBeenLastCalledWith({ first: lastFile, last: firstFile });
  });
});

describe('VideoReferenceAssets（全能参考资产组）', () => {
  function setup(overrides = {}) {
    const props = {
      caps: seedance,
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

  it('shows image + video + audio groups for seedance caps', () => {
    setup();
    expect(screen.getByLabelText('上传参考图')).toBeInTheDocument();
    expect(screen.getByLabelText('上传参考视频')).toBeInTheDocument();
    expect(screen.getByLabelText('上传参考音频')).toBeInTheDocument();
  });

  it('hides video/audio groups when caps do not support them', () => {
    setup({ caps: videoControlCaps('unknown-model') });
    expect(screen.getByLabelText('上传参考图')).toBeInTheDocument();
    expect(screen.queryByLabelText('上传参考视频')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('上传参考音频')).not.toBeInTheDocument();
  });
});
