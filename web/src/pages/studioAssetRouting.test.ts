import { describe, expect, it } from 'vitest';

import { videoControlCaps } from '@/lib/videoControlCaps';
import { routeStudioMediaAsset, type StudioMediaSlots } from './studioAssetRouting';

const empty = { images: 0, mj: 0, videos: 0, audios: 0 };
const seedance = videoControlCaps('doubao-seedance-2-0-260128', 'seedance');

function slots(overrides: Partial<StudioMediaSlots>): StudioMediaSlots {
  return { kind: 'image', videoMode: 'omni', model: 'gpt-image-2', videoCaps: seedance, counts: empty, ...overrides };
}

describe('routeStudioMediaAsset', () => {
  it('图片模式：图片进参考图，MJ 进垫图组，满了给提示', () => {
    expect(routeStudioMediaAsset('image/png', slots({}))).toEqual({ target: 'images' });
    expect(routeStudioMediaAsset('image/png', slots({ model: 'midjourney' }))).toEqual({ target: 'mj' });
    expect(routeStudioMediaAsset('image/png', slots({ model: 'midjourney', counts: { ...empty, mj: 4 } })))
      .toEqual({ notice: '参考图已满' });
    expect(routeStudioMediaAsset('image/png', slots({ counts: { ...empty, images: 99 } })))
      .toEqual({ notice: '参考图已满' });
  });

  it('图片模式不收视频 / 音频', () => {
    expect(routeStudioMediaAsset('video/mp4', slots({}))).toEqual({ notice: '当前模式不支持视频参考' });
    expect(routeStudioMediaAsset('audio/mpeg', slots({}))).toEqual({ notice: '当前模式不支持音频参考' });
  });

  it('视频全能参考：按 mime 分流进三组，按模型上限截住', () => {
    const omni = slots({ kind: 'video', videoMode: 'omni' });
    expect(routeStudioMediaAsset('image/webp', omni)).toEqual({ target: 'images' });
    expect(routeStudioMediaAsset('video/mp4', omni)).toEqual({ target: 'videos' });
    expect(routeStudioMediaAsset('audio/wav', omni)).toEqual({ target: 'audios' });
    expect(routeStudioMediaAsset('video/mp4', { ...omni, counts: { ...empty, videos: 3 } }))
      .toEqual({ notice: '参考视频已满' });
    expect(routeStudioMediaAsset('audio/wav', { ...omni, counts: { ...empty, audios: 3 } }))
      .toEqual({ notice: '参考音频已满' });
  });

  it('视频模型不支持参考视频 / 音频时不加入', () => {
    const noRefs = { ...seedance, supportsReferenceVideo: false, supportsReferenceAudio: false };
    const omni = slots({ kind: 'video', videoMode: 'omni', videoCaps: noRefs });
    expect(routeStudioMediaAsset('video/mp4', omni)).toEqual({ notice: '当前模型不支持视频参考' });
    expect(routeStudioMediaAsset('audio/mpeg', omni)).toEqual({ notice: '当前模型不支持音频参考' });
  });

  it('首尾帧：图片进首帧，没有帧槽时拒绝，视频 / 音频不收', () => {
    const frames = slots({ kind: 'video', videoMode: 'firstlast' });
    expect(routeStudioMediaAsset('image/png', frames)).toEqual({ target: 'frame' });
    expect(routeStudioMediaAsset('image/png', { ...frames, videoCaps: { ...seedance, maxFrames: 0 } }))
      .toEqual({ notice: '当前模型不支持参考图' });
    expect(routeStudioMediaAsset('video/mp4', frames)).toEqual({ notice: '当前模式不支持视频参考' });
  });

  it('其他类型不收', () => {
    expect(routeStudioMediaAsset('application/pdf', slots({}))).toEqual({ notice: '不支持这种文件' });
  });
});
