/** 按模型族描述视频控件能力：决定 VideoControls 显示哪些选项、VideoReferenceAssets 开放哪些上传槽。
 *
 * 与 imageControlCaps.ts 同构。Seedance（火山 Ark 直连，doubao-seedance-*）一个端点吃全套输入矩阵；
 * 未知模型走保守默认（只文生 + 单图自动，不开放视频/音频参考）。
 */

/** 视频输入模式（UI 概念，决定开放哪些上传槽）。 */
export type VideoMode = 't2v' | 'i2v' | 'ref' | 'v2v';

/** 帧模式 —— 必须与 jobs.ts::JobParams.frame_mode 和 volcengine_video._frame_role 对齐。 */
export type VideoFrameMode = 'auto' | 'first' | 'firstlast';

export interface VideoControlCaps {
  family: 'seedance' | 'standard';
  /** 可选时长（秒）。 */
  durations: number[];
  /** 可选分辨率（传给后端 params.resolution 的字符串）。 */
  resolutions: string[];
  /** 可选画幅比例（传给后端 params.ratio）。 */
  ratios: string[];
  /** 图生视频支持的帧模式。 */
  frameModes: VideoFrameMode[];
  /** 是否支持「生成音频」开关（params.generate_audio）。 */
  supportsAudio: boolean;
  /** 是否支持参考视频（params.reference_videos）。 */
  supportsReferenceVideo: boolean;
  /** 是否支持参考音频（params.reference_audios）。 */
  supportsReferenceAudio: boolean;
}

const SEEDANCE_CAPS: VideoControlCaps = {
  family: 'seedance',
  durations: [5, 10],
  resolutions: ['480p', '720p', '1080p'],
  ratios: ['16:9', '9:16', '1:1', '4:3', '21:9'],
  frameModes: ['auto', 'first', 'firstlast'],
  supportsAudio: true,
  supportsReferenceVideo: true,
  supportsReferenceAudio: true,
};

const STANDARD_CAPS: VideoControlCaps = {
  family: 'standard',
  durations: [5],
  resolutions: ['720p'],
  ratios: ['16:9', '9:16', '1:1'],
  frameModes: ['auto'],
  supportsAudio: false,
  supportsReferenceVideo: false,
  supportsReferenceAudio: false,
};

export function videoControlCaps(modelId?: string | null): VideoControlCaps {
  const id = (modelId ?? '').toLowerCase();
  if (id.includes('seedance')) return SEEDANCE_CAPS;
  return STANDARD_CAPS;
}

/** 各视频模式的中文标签（VideoControls 模式下拉用）。 */
export const VIDEO_MODE_LABELS: Record<VideoMode, string> = {
  t2v: '文生视频',
  i2v: '图生视频',
  ref: '参考生视频',
  v2v: '视频生视频',
};

/** 各帧模式的中文标签。 */
export const FRAME_MODE_LABELS: Record<VideoFrameMode, string> = {
  auto: '自动',
  first: '首帧',
  firstlast: '首尾帧',
};
