import { describe, expect, it } from 'vitest';
import { videoControlCaps } from './videoControlCaps';

describe('videoControlCaps', () => {
  it('seedance 2.0 supports the full matrix with official duration/ratio ranges', () => {
    const caps = videoControlCaps('seedance-2.0');
    expect(caps.family).toBe('seedance');
    expect(caps.modes).toEqual(['firstlast', 'omni']);
    // 官方 duration [4,15] 任意整数秒
    expect(caps.durations[0]).toBe(4);
    expect(caps.durations[caps.durations.length - 1]).toBe(15);
    expect(caps.ratios).toContain('3:4');
    expect(caps.ratios).toContain('adaptive');
    expect(caps.resolutions).toContain('1080p');
    expect(caps.supportsAudio).toBe(true);
    expect(caps.supportsReferenceVideo).toBe(true);
    expect(caps.supportsReferenceAudio).toBe(true);
    expect(caps.maxFrames).toBe(2);
  });

  it('seedance 2.0-fast drops 1080p but keeps the 2.0 matrix', () => {
    const caps = videoControlCaps('doubao-seedance-2-0-fast-260128');
    expect(caps.family).toBe('seedance');
    expect(caps.resolutions).toEqual(['480p', '720p']);
    expect(caps.durations).toContain(15);
    expect(caps.supportsReferenceVideo).toBe(true);
  });

  it('seedance 1.5pro/1.0pro are firstlast-only with their own duration ranges', () => {
    const pro15 = videoControlCaps('doubao-seedance-1-5-pro-260428');
    expect(pro15.modes).toEqual(['firstlast']);
    expect(pro15.durations[0]).toBe(4);
    expect(pro15.durations[pro15.durations.length - 1]).toBe(12);
    expect(pro15.ratios).toContain('adaptive');
    expect(pro15.supportsAudio).toBe(true);
    expect(pro15.supportsReferenceVideo).toBe(false);

    const pro10 = videoControlCaps('doubao-seedance-1-0-pro-250528');
    expect(pro10.durations[0]).toBe(2);
    expect(pro10.ratios).not.toContain('adaptive');
    expect(pro10.supportsAudio).toBe(false);
  });

  it('happyhorse four modes map to four model ids', () => {
    const t2v = videoControlCaps('happyhorse-1.0-t2v');
    expect(t2v.family).toBe('happyhorse');
    expect(t2v.modes).toEqual(['firstlast']);
    expect(t2v.maxFrames).toBe(0); // 纯文生，无帧槽
    expect(t2v.resolutions).toEqual(['720P', '1080P']);
    expect(t2v.durations[0]).toBe(3);
    expect(t2v.durations[t2v.durations.length - 1]).toBe(15);
    expect(t2v.ratios).toContain('4:5');

    const i2v = videoControlCaps('happyhorse-1.0-i2v');
    expect(i2v.maxFrames).toBe(1); // 仅首帧
    expect(i2v.ratios).toEqual([]); // 比例随首帧

    const r2v = videoControlCaps('happyhorse-1.0-r2v');
    expect(r2v.modes).toEqual(['omni']);
    expect(r2v.supportsReferenceVideo).toBe(false);

    const edit = videoControlCaps('happyhorse-1.0-video-edit');
    expect(edit.modes).toEqual(['omni']);
    expect(edit.durations).toEqual([]); // 时长随输入视频
    expect(edit.ratios).toEqual([]);
    expect(edit.supportsReferenceVideo).toBe(true);
    expect(edit.maxRefImages).toBe(5);
    expect(edit.maxRefVideos).toBe(1);
  });

  it('matches seedance by substring too', () => {
    expect(videoControlCaps('seedance-lite').family).toBe('seedance');
  });

  it('falls back to a conservative default for unknown models', () => {
    const caps = videoControlCaps('some-unknown-video-model');
    expect(caps.family).toBe('standard');
    expect(caps.supportsReferenceVideo).toBe(false);
    expect(caps.supportsReferenceAudio).toBe(false);
    expect(caps.supportsAudio).toBe(false);
  });

  it('handles null/undefined modelId without throwing', () => {
    expect(videoControlCaps(undefined).family).toBe('standard');
    expect(videoControlCaps(null).family).toBe('standard');
  });

  it('protocol 显式驱动 family（custom 模型 id 不含族关键词也能定族）', () => {
    expect(videoControlCaps('foo-1', 'seedance').family).toBe('seedance');
    expect(videoControlCaps('foo-1', 'dashscope').family).toBe('happyhorse');
    expect(videoControlCaps('foo-1', 'kling').family).toBe('kling');
  });

  it('无 protocol 时退回按 modelId 子串识别（命名 provider / 历史调用）', () => {
    expect(videoControlCaps('seedance-2.0').family).toBe('seedance');
    expect(videoControlCaps('foo-1').family).toBe('standard');
    expect(videoControlCaps('foo-1', null).family).toBe('standard');
  });
});
