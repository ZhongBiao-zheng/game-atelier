/** 按模型族描述视频控件能力：决定 VideoControls 显示哪些选项、VideoReferenceAssets 开放哪些上传槽。
 *
 * 与 imageControlCaps.ts 同构。Seedance（火山 Ark 直连，doubao-seedance-*）一个端点吃全套输入矩阵；
 * 未知模型走保守默认（只文生 + 单图自动，不开放视频/音频参考）。
 */

/** 视频生成方式（UI 概念，决定开放哪些上传槽）。
 * 文生视频不再是显式选项：首尾帧模式下不传任何帧 = 文生视频。
 */
export type VideoMode = 'firstlast' | 'omni';

/** 帧模式（wire 值）—— 必须与 jobs.ts::JobParams.frame_mode 和 volcengine_video._frame_role 对齐。
 * 不再是用户选项：提交时按首尾槽推导（双帧→firstlast、仅首→first、仅尾→last、全空→省略=文生视频）。
 */
export type VideoFrameMode = 'auto' | 'first' | 'last' | 'firstlast';

export interface VideoControlCaps {
  family: 'seedance' | 'standard';
  /** 可选时长（秒）。 */
  durations: number[];
  /** 可选分辨率（传给后端 params.resolution 的字符串）。 */
  resolutions: string[];
  /** 可选画幅比例（传给后端 params.ratio）。 */
  ratios: string[];
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
  supportsAudio: true,
  supportsReferenceVideo: true,
  supportsReferenceAudio: true,
};

const STANDARD_CAPS: VideoControlCaps = {
  family: 'standard',
  durations: [5],
  resolutions: ['720p'],
  ratios: ['16:9', '9:16', '1:1'],
  supportsAudio: false,
  supportsReferenceVideo: false,
  supportsReferenceAudio: false,
};

export function videoControlCaps(modelId?: string | null): VideoControlCaps {
  const id = (modelId ?? '').toLowerCase();
  if (id.includes('seedance')) return SEEDANCE_CAPS;
  return STANDARD_CAPS;
}

/** 各生成方式的中文标签（VideoControls 汇总弹窗用）。 */
export const VIDEO_MODE_LABELS: Record<VideoMode, string> = {
  firstlast: '首尾帧',
  omni: '全能参考',
};
