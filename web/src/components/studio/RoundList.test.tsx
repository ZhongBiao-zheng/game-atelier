import { fireEvent, render, screen } from '@testing-library/react';
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

const videoWithRefs: RoundState = {
  kind: 'done',
  jobId: 'job-vid-2',
  submittedAt: new Date().toISOString(),
  imagePaths: ['/data/studio/job-vid-2/v1.mp4'],
  config: {
    // job 里存的是序列化后的 prompt（@视频1 → 视频1），历史 chip 化按此形态匹配。
    prompt: '为视频1 添加图1 风格，配上音频1',
    model: 'doubao-seedance-2-0-fast-260128',
    kind: 'video',
    referenceImages: ['/uploads/ref.png'],
    referenceVideos: ['/uploads/ref.mp4'],
    referenceAudios: ['/uploads/ref.mp3'],
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

describe('RoundList skill 出图删除门控', () => {
  const imageDone = (mode?: 'image' | 'skill'): RoundState => ({
    kind: 'done',
    mode,
    jobId: 'job-img-1',
    submittedAt: new Date().toISOString(),
    imagePaths: ['/data/characters/cao-cao/promo/v1.png'],
    config: { prompt: '立绘', model: 'gpt-image-2', kind: 'image', referenceImages: [] },
  });

  it('studio 出图保留「更多操作」（含删除该批次）', () => {
    render(<RoundList rounds={[imageDone('image')]} />);
    expect(screen.getByLabelText('更多操作')).toBeInTheDocument();
  });

  it('skill 出图不暴露删除入口（防从出图页抹掉角色磁盘资产）', () => {
    render(<RoundList rounds={[imageDone('skill')]} />);
    expect(screen.queryByLabelText('更多操作')).toBeNull();
  });
});

describe('RoundList progress badge', () => {
  function pendingRound(over: Record<string, unknown>): RoundState {
    return {
      kind: 'pending',
      jobId: 'job-p1',
      startedAt: Date.now(),
      config: {
        prompt: 'p',
        model: 'm',
        kind: 'video',
        duration: 5,
        referenceImages: [],
      },
      ...over,
    } as RoundState;
  }

  it('shows 0% for a video round not yet sent upstream', () => {
    render(<RoundList rounds={[pendingRound({ progressPhase: null })]} />);
    expect(screen.getByTestId('progress-badge').textContent).toBe('0% 生成中');
  });

  it('shows 20% once the task is sent and 95% while downloading', () => {
    const { unmount } = render(<RoundList rounds={[pendingRound({ progressPhase: 'sent' })]} />);
    expect(screen.getByTestId('progress-badge').textContent).toBe('20% 生成中');
    unmount();
    render(<RoundList rounds={[pendingRound({ progressPhase: 'downloading' })]} />);
    expect(screen.getByTestId('progress-badge').textContent).toBe('95% 生成中');
  });

  it('shows time-stepped percent for image rounds (20% when fresh)', () => {
    const imageRound = pendingRound({
      config: { prompt: 'p', model: 'm', kind: 'image', referenceImages: [] },
    });
    render(<RoundList rounds={[imageRound]} />);
    expect(screen.getByTestId('progress-badge').textContent).toBe('20% 生成中');
  });
});

describe('RoundList reference assets', () => {
  it('shows the reference stack for video rounds with only video/audio refs', () => {
    const onlyMedia: RoundState = {
      ...videoWithRefs,
      config: { ...videoWithRefs.config, referenceImages: [] },
    };
    render(<RoundList rounds={[onlyMedia]} />);
    expect(screen.getByTestId('reference-stack')).toBeInTheDocument();
  });

  it('renders serialized mention tokens in the prompt as chips with labels', () => {
    const { container } = render(<RoundList rounds={[videoWithRefs]} />);
    expect(container.querySelector('[data-mention="视频1"]')).not.toBeNull();
    expect(container.querySelector('[data-mention="图1"]')).not.toBeNull();
    expect(container.querySelector('[data-mention="音频1"]')).not.toBeNull();
    expect(container.textContent).toContain('视频1');
  });

  it('keeps tokens without a matching reference as plain text (no chip)', () => {
    const noRefs: RoundState = {
      ...videoWithRefs,
      config: { ...videoWithRefs.config, prompt: '视频1 里有 2 只猫', referenceVideos: [] },
    };
    const { container } = render(<RoundList rounds={[noRefs]} />);
    expect(container.querySelector('[data-mention]')).toBeNull();
    expect(container.textContent).toContain('视频1 里有 2 只猫');
  });

  it('shows a hover preview above a mention chip and hides it on leave', () => {
    const { container } = render(<RoundList rounds={[videoWithRefs]} />);
    const chip = container.querySelector('[data-mention="视频1"]')!;
    fireEvent.mouseEnter(chip);
    const preview = document.body.querySelector('[data-testid="round-mention-preview"]');
    expect(preview).not.toBeNull();
    expect(preview!.querySelector('video')).not.toBeNull();
    fireEvent.mouseLeave(chip);
    expect(document.body.querySelector('[data-testid="round-mention-preview"]')).toBeNull();
  });
});
