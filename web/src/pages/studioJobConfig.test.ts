import { describe, expect, it } from 'vitest';

import type { Job, JobParams } from '@/schema/jobs';
import { configForJob, isOmniVideoConfig, referencePathCounts } from './studioJobConfig';

function job(params: JobParams, overrides: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    character_id: '',
    prompt: 'p',
    submitted_at: '2026-09-20T10:00:00Z',
    model: 'gpt-image-2',
    params,
    output_paths: [],
    status: 'done',
    error: null,
    kind: 'image',
    ...overrides,
  };
}

const none = { images: 0, videos: 0, audios: 0 };

describe('isOmniVideoConfig', () => {
  it('有视频或音频参考即全能参考，不看 frameMode', () => {
    expect(isOmniVideoConfig('firstlast', { ...none, videos: 1 })).toBe(true);
    expect(isOmniVideoConfig('first', { ...none, audios: 1 })).toBe(true);
  });

  it('只有参考图时：无帧语义（缺省 / auto）为全能参考，有帧语义为首尾帧', () => {
    expect(isOmniVideoConfig(undefined, { ...none, images: 2 })).toBe(true);
    expect(isOmniVideoConfig('auto', { ...none, images: 1 })).toBe(true);
    expect(isOmniVideoConfig('first', { ...none, images: 1 })).toBe(false);
    expect(isOmniVideoConfig('last', { ...none, images: 1 })).toBe(false);
    expect(isOmniVideoConfig('firstlast', { ...none, images: 2 })).toBe(false);
  });

  it('没有任何参考不是全能参考', () => {
    expect(isOmniVideoConfig(undefined, none)).toBe(false);
    expect(isOmniVideoConfig('auto', none)).toBe(false);
  });

  it('referencePathCounts 数 RoundConfig 上的三组路径', () => {
    const config = configForJob(job(
      { reference_images: ['a.png', 'b.png'], reference_videos: ['v.mp4'] },
      { kind: 'video', model: 'doubao-seedance-2-0-260128' },
    ));
    expect(referencePathCounts(config)).toEqual({ images: 2, videos: 1, audios: 0 });
    expect(referencePathCounts(configForJob(job({})))).toEqual(none);
  });
});

describe('configForJob 枚举字段', () => {
  it('合法 frame_mode 原样保留', () => {
    for (const mode of ['auto', 'first', 'last', 'firstlast'] as const) {
      expect(configForJob(job({ frame_mode: mode }, { kind: 'video' })).frameMode).toBe(mode);
    }
  });

  it('非法 frame_mode 当缺省处理', () => {
    const params = { frame_mode: 'middle' } as unknown as JobParams;
    expect(configForJob(job(params, { kind: 'video' })).frameMode).toBeUndefined();
  });

  it('合法 size_mode 原样保留', () => {
    for (const mode of ['auto', 'ratio', 'custom'] as const) {
      expect(configForJob(job({ size_mode: mode })).sizeMode).toBe(mode);
    }
  });

  it('非法 size_mode 当缺省处理，按 size 推断', () => {
    const bogus = (size?: string) => ({ size_mode: 'fixed', size }) as unknown as JobParams;
    expect(configForJob(job(bogus())).sizeMode).toBe('ratio');
    expect(configForJob(job(bogus('auto'))).sizeMode).toBe('auto');
  });
});
