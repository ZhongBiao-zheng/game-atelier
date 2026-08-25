import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('does not create players or decode reference videos before the round nears the viewport', () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '600px 0px';
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      disconnect() {}
      observe() {}
      takeRecords() { return []; }
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    const createElement = vi.spyOn(document, 'createElement');
    const round: RoundState = {
      ...videoWithRefs,
      jobId: 'job-lazy-video',
      imagePaths: ['/data/studio/job-lazy-video/v1.mp4'],
      config: {
        ...videoWithRefs.config,
        referenceVideos: ['/uploads/lazy-reference.mp4'],
      },
    };

    const { container } = render(<RoundList rounds={[round]} />);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByTestId('studio-video-placeholder')).toBeInTheDocument();
    expect(createElement.mock.calls.filter(([tag]) => tag === 'video')).toHaveLength(0);

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(container.querySelector('video')).not.toBeNull();
    expect(createElement.mock.calls.filter(([tag]) => tag === 'video').length).toBeGreaterThan(0);
    const hiddenDecoder = createElement.mock.results
      .map(({ value }) => value)
      .find((node): node is HTMLVideoElement => (
        node instanceof HTMLVideoElement
        && node.preload === 'auto'
        && !container.contains(node)
      ));
    expect(hiddenDecoder?.getAttribute('src')).toContain('lazy-reference.mp4');

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(container.querySelector('video')).toBeNull();
    expect(hiddenDecoder?.getAttribute('src')).toBeNull();
  });

  it('mounts only the newest 30 rounds initially and loads older history in batches', () => {
    const rounds = Array.from({ length: 100 }, (_, index): RoundState => ({
      ...videoDone,
      jobId: `job-video-${index}`,
      submittedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      imagePaths: [`/data/studio/job-video-${index}/v1.mp4`],
    }));
    const { container } = render(<RoundList rounds={rounds} />);

    expect(container.querySelectorAll('[data-round-job]')).toHaveLength(30);
    expect(container.querySelector('[data-round-job="job-video-0"]')).toBeNull();
    expect(container.querySelector('[data-round-job="job-video-99"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '加载更早记录（剩余 70 条）' }));
    expect(container.querySelectorAll('[data-round-job]')).toHaveLength(60);
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录（剩余 40 条）' }));
    expect(container.querySelectorAll('[data-round-job]')).toHaveLength(90);
    fireEvent.click(screen.getByRole('button', { name: '加载更早记录（剩余 10 条）' }));
    expect(container.querySelectorAll('[data-round-job]')).toHaveLength(100);
    expect(screen.queryByRole('button', { name: /加载更早记录/ })).toBeNull();
  });

  it('keeps an older deep-linked round mounted outside the newest batch', () => {
    const rounds = Array.from({ length: 40 }, (_, index): RoundState => ({
      ...videoDone,
      jobId: `job-focus-${index}`,
      submittedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      imagePaths: [`/data/studio/job-focus-${index}/v1.mp4`],
    }));
    const { container } = render(<RoundList rounds={rounds} focusJobId="job-focus-2" />);
    expect(container.querySelector('[data-round-job="job-focus-2"]')).not.toBeNull();
    expect(container.querySelector('[data-round-job="job-focus-39"]')).not.toBeNull();
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

describe('RoundList 归档到项目', () => {
  const imageDone: RoundState = {
    kind: 'done',
    mode: 'image',
    jobId: 'job-archive-image',
    submittedAt: '2026-08-21T10:00:00Z',
    imagePaths: ['/data/studio/job-archive-image/v1.png'],
    config: { prompt: '立绘', model: 'gpt-image-2', kind: 'image', referenceImages: [] },
  };

  it('每个 Studio 图片和视频产物都能明确发起归档', () => {
    const onArchive = vi.fn();
    render(<RoundList rounds={[imageDone, videoDone]} onArchive={onArchive} />);

    fireEvent.click(screen.getByLabelText('归档生成结果 1 到项目'));
    expect(onArchive).toHaveBeenCalledWith(
      'job-archive-image',
      '/data/studio/job-archive-image/v1.png',
      'image',
    );

    fireEvent.click(screen.getByLabelText('归档生成视频 1 到项目'));
    expect(onArchive).toHaveBeenCalledWith(
      'job-vid-1',
      '/data/studio/job-vid-1/v1.mp4',
      'video',
    );
  });

  it('Skill 正式资产不重复显示归档入口', () => {
    render(
      <RoundList
        rounds={[{ ...imageDone, mode: 'skill' }]}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('归档生成结果 1 到项目')).not.toBeInTheDocument();
  });
});

describe('RoundList 静默改写提示（params.warnings）', () => {
  const withWarnings = (warnings?: string[]): RoundState => ({
    kind: 'done',
    jobId: 'job-warn-1',
    submittedAt: new Date().toISOString(),
    imagePaths: ['/data/studio/job-warn-1/v1.png'],
    config: { prompt: '一张图', model: 'doubao-seedream-4-5-251128', kind: 'image', referenceImages: [], warnings },
  });

  it('后端回写的提示逐条展示', () => {
    render(<RoundList rounds={[withWarnings(['尺寸 2048x1152 已归一化为 2560x1440', '参考图超过上限，只发了前 10 张'])]} />);
    expect(screen.getByTestId('round-warnings').children).toHaveLength(2);
    expect(screen.getByText('尺寸 2048x1152 已归一化为 2560x1440')).toBeInTheDocument();
  });

  it('没有提示时不占位', () => {
    render(<RoundList rounds={[withWarnings([])]} />);
    expect(screen.queryByTestId('round-warnings')).toBeNull();
    cleanup();
    render(<RoundList rounds={[withWarnings(undefined)]} />);
    expect(screen.queryByTestId('round-warnings')).toBeNull();
  });
});

describe('RoundList 单图隐藏', () => {
  const imageDone: RoundState = {
    kind: 'done',
    jobId: 'job-hide-1',
    submittedAt: new Date().toISOString(),
    imagePaths: ['/data/studio/job-hide-1/v1.png', '/data/studio/job-hide-1/v2.png'],
    config: { prompt: '两张图', model: 'gpt-image-2', kind: 'image', referenceImages: [] },
  };

  it('传了 onToggleHidden 时每张图渲染隐藏按钮，点击回传该图 path', () => {
    const onToggleHidden = vi.fn();
    render(<RoundList rounds={[imageDone]} hiddenPaths={[]} onToggleHidden={onToggleHidden} />);
    const buttons = screen.getAllByLabelText('隐藏（不在首页展示）');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onToggleHidden).toHaveBeenCalledWith('/data/studio/job-hide-1/v2.png');
  });

  it('已隐藏的图显示「取消隐藏」态（后缀比对：sidecar 存相对路径）', () => {
    render(
      <RoundList
        rounds={[imageDone]}
        hiddenPaths={['studio/job-hide-1/v1.png']}
        onToggleHidden={() => {}}
      />,
    );
    expect(screen.getAllByLabelText('取消隐藏')).toHaveLength(1);
    expect(screen.getAllByLabelText('隐藏（不在首页展示）')).toHaveLength(1);
  });

  it('不传 onToggleHidden 时不渲染隐藏按钮（视频卡也没有）', () => {
    render(<RoundList rounds={[imageDone, videoDone]} />);
    expect(screen.queryByLabelText('隐藏（不在首页展示）')).toBeNull();
  });
});

describe('RoundList 图卡编辑（导入为参考图）', () => {
  const imageDone: RoundState = {
    kind: 'done',
    jobId: 'job-edit-1',
    submittedAt: new Date().toISOString(),
    imagePaths: ['/data/studio/job-edit-1/v1.png', '/data/studio/job-edit-1/v2.png'],
    config: { prompt: '两张图', model: 'gpt-image-2', kind: 'image', referenceImages: [] },
  };

  it('传了 onEditAsReference 时每张图渲染编辑按钮，点击回传该图 path', () => {
    const onEditAsReference = vi.fn();
    render(<RoundList rounds={[imageDone]} onEditAsReference={onEditAsReference} />);
    const buttons = screen.getAllByTitle('编辑（导入为参考图）');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onEditAsReference).toHaveBeenCalledWith('/data/studio/job-edit-1/v2.png');
  });

  it('不传 onEditAsReference 时不渲染编辑按钮（视频卡也没有）', () => {
    render(<RoundList rounds={[imageDone, videoDone]} onEditAsReference={undefined} />);
    expect(screen.queryByTitle('编辑（导入为参考图）')).toBeNull();
    cleanup();
    render(<RoundList rounds={[videoDone]} onEditAsReference={vi.fn()} />);
    expect(screen.queryByTitle('编辑（导入为参考图）')).toBeNull();
  });
});

describe('RoundList 深链定位锚点', () => {
  const imageDone: RoundState = {
    kind: 'done',
    jobId: 'job-focus-1',
    submittedAt: new Date().toISOString(),
    imagePaths: ['/data/studio/job-focus-1/v1.png'],
    config: { prompt: '定位这轮', model: 'gpt-image-2', kind: 'image', referenceImages: [] },
  };

  it('每轮带 data-round-job 锚点，且不渲染高亮环（高亮会推移布局，已砍）', () => {
    const { container } = render(<RoundList rounds={[imageDone]} />);
    const anchor = container.querySelector('[data-round-job="job-focus-1"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.className ?? '').not.toContain('ring-primary');
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

describe('RoundList done metadata: 耗时 + 生成时间', () => {
  const timedDone: RoundState = {
    kind: 'done',
    jobId: 'job-timed',
    submittedAt: '2026-07-08T10:00:00+00:00',
    completedAt: '2026-07-08T10:00:12+00:00', // +12s；北京时间 = UTC+8 → 18:00
    imagePaths: ['/data/studio/job-timed/v1.png'],
    config: {
      prompt: '一张图',
      model: 'gpt-image-2',
      kind: 'image',
      ratio: '16:9',
      resolution: '2K',
      referenceImages: [],
    },
  };

  it('显示出图耗时（completed_at − submitted_at）与北京时间生成时间', () => {
    const { container } = render(<RoundList rounds={[timedDone]} />);
    expect(container.textContent).toContain('耗时 12s');
    expect(container.textContent).toContain('2026-07-08 18:00');
  });

  it('耗时/生成时间与出图参数分行（次行更小更淡，参数行不含耗时）', () => {
    const { container, getByTestId } = render(<RoundList rounds={[timedDone]} />);
    const runLine = getByTestId('round-run-meta');
    expect(runLine.textContent).toContain('耗时 12s');
    expect(runLine.textContent).toContain('2026-07-08 18:00');
    expect(runLine.className).toContain('text-xs');
    // 参数行是另一个元素，不含耗时/时间
    const specLine = Array.from(container.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('gpt-image-2'),
    );
    expect(specLine).toBeTruthy();
    expect(specLine).not.toBe(runLine);
    expect(specLine!.textContent).not.toContain('耗时');
  });

  it('旧 job 无 completed_at 时不显示耗时/时间（优雅降级）', () => {
    const { completedAt: _omit, ...legacy } = timedDone;
    const { container } = render(<RoundList rounds={[legacy as RoundState]} />);
    expect(container.textContent).not.toContain('耗时');
  });
});

describe('RoundList 生成中占位按目标比例', () => {
  function pendingWith(config: Record<string, unknown>): RoundState {
    return {
      kind: 'pending',
      jobId: 'job-ph',
      startedAt: Date.now(),
      config: { prompt: 'p', model: 'gpt-image-2', kind: 'image', referenceImages: [], ...config },
    } as RoundState;
  }

  it('比例 9:16 → 占位框 aspect-ratio 9 / 16（不再固定 1:1 方框）', () => {
    const { container } = render(<RoundList rounds={[pendingWith({ ratio: '9:16' })]} />);
    const skel = container.querySelector('[data-skeleton]') as HTMLElement;
    expect(skel.style.aspectRatio).toBe('9 / 16');
  });

  it('无比例退回尺寸 1024x1536 → 1024 / 1536；都无退回 1 / 1', () => {
    const { container: c1 } = render(<RoundList rounds={[pendingWith({ size: '1024x1536' })]} />);
    expect((c1.querySelector('[data-skeleton]') as HTMLElement).style.aspectRatio).toBe('1024 / 1536');
    const { container: c2 } = render(<RoundList rounds={[pendingWith({})]} />);
    expect((c2.querySelector('[data-skeleton]') as HTMLElement).style.aspectRatio).toBe('1 / 1');
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

  it('renders skill prompt @图片N aliases with the same omni reference chip', () => {
    const round: RoundState = {
      ...videoWithRefs,
      config: {
        ...videoWithRefs.config,
        prompt: '曹操@图片1 推出一张牌',
      },
    };
    const { container } = render(<RoundList rounds={[round]} />);
    const chip = container.querySelector('[data-mention="图1"]');
    expect(chip).not.toBeNull();
    expect(chip?.querySelector('img')?.getAttribute('src')).toContain('job_id=job-vid-2');
    expect(container.textContent).not.toContain('@图片1');
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

  it('MJ 历史把四类参考图并入缩略图堆叠，并从文字参数中移除参考 URL', () => {
    const round: RoundState = {
      kind: 'done',
      jobId: 'job-mj-refs',
      submittedAt: new Date().toISOString(),
      imagePaths: ['/data/studio/job-mj-refs/v1.png'],
      config: {
        prompt: '东方庭院',
        model: 'mj_fast_imagine',
        kind: 'image',
        referenceImages: ['/other-game/characters/hero.png'],
        mjRefPaths: {
          sref: ['/runtime/uploads/style-a.png', 'https://cdn.example/style-b.png'],
          cref: ['/runtime/uploads/character.png'],
        },
        mjFlags: '--v 6 --sref https://oss.example/style-a.png https://oss.example/style-b.png --sw 300 --cref https://oss.example/character.png --cw 60 --chaos 10',
      },
    };

    const onReuseReferences = vi.fn();
    render(<RoundList rounds={[round]} onReuseReferences={onReuseReferences} />);
    const stack = screen.getByTestId('reference-stack');
    expect(stack.children).toHaveLength(4);
    expect(stack.querySelector('img')?.getAttribute('src')).toContain('job_id=job-mj-refs');
    expect(stack.querySelector('img')?.getAttribute('src')).toContain('/api/raw');
    fireEvent.click(stack);
    expect(onReuseReferences).toHaveBeenCalledWith(round.config, 'job-mj-refs');
    expect(screen.getByTestId('round-mj-flags')).toHaveTextContent('--v 6 --chaos 10');
    expect(screen.getByTestId('round-mj-flags')).not.toHaveTextContent('oss.example');
    expect(screen.getByTestId('round-mj-flags')).not.toHaveTextContent('--sref');
  });
});
