import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RoundList, type RoundState } from './RoundList';

const videoDone: RoundState = {
  kind: 'done',
  jobId: 'job-vid-1',
  submittedAt: new Date().toISOString(),
  imagePaths: ['/data/studio/job-vid-1/v1.mp4'],
  config: {
    prompt: '一只猫在跳舞',
    model: 'doubao-seedance-2-0-fast-260128',
    kind: 'video',
    referenceImages: [],
  },
};

describe('RoundList video', () => {
  it('renders a <video> element for a video round', () => {
    const { container } = render(<RoundList rounds={[videoDone]} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toContain('/api/gallery/image?path=');
  });

  it('renders the prompt text', () => {
    render(<RoundList rounds={[videoDone]} />);
    expect(screen.getByText('一只猫在跳舞')).toBeInTheDocument();
  });
});
