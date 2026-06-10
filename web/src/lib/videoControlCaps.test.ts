import { describe, expect, it } from 'vitest';
import { videoControlCaps } from './videoControlCaps';

describe('videoControlCaps', () => {
  it('seedance supports the full matrix', () => {
    const caps = videoControlCaps('doubao-seedance-2-0-fast-260128');
    expect(caps.family).toBe('seedance');
    expect(caps.durations).toEqual([5, 10]);
    expect(caps.resolutions).toContain('720p');
    expect(caps.supportsAudio).toBe(true);
    expect(caps.supportsReferenceVideo).toBe(true);
    expect(caps.supportsReferenceAudio).toBe(true);
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
});
