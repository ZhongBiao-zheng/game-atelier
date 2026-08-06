/** 按模型族描述视频控件能力：决定 VideoControls 显示哪些选项、VideoReferenceAssets 开放哪些上传槽。
 *
 * 与 imageControlCaps.ts 同构。参数档位以官方契约为准（docs/references/provider-config.md）：
 * - Seedance（火山 Ark / TokenDance 转发）按代际分叉：2.0 系全矩阵，1.5pro/1.0pro 只有首尾帧。
 * - HappyHorse（阿里百炼 / TokenDance 转发）四模式 = 四个模型 id（t2v/i2v/r2v/video-edit）。
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

/** 可灵生成档位（wire 值 = kling API 的 mode 参数，写进 params.mode）。 */
export type VideoQuality = 'std' | 'pro';

export interface VideoControlCaps {
  family: 'seedance' | 'happyhorse' | 'kling' | 'openrouter' | 'standard';
  /** 可用生成方式；只有一种时 VideoControls 隐藏该分区。 */
  modes: VideoMode[];
  /** 可选时长（秒）；空数组 = 该模式无时长参数（如 happyhorse video-edit 随输入），隐藏分区。 */
  durations: number[];
  /** 可选分辨率（传给后端 params.resolution 的字符串）；空数组 = 该族无分辨率参数，隐藏分区。 */
  resolutions: string[];
  /** 可选画幅比例（传给后端 params.ratio）；空数组 = 无比例参数（如 i2v 随首帧），隐藏分区。 */
  ratios: string[];
  /** 可选生成档位（kling 的 mode std/pro，传给后端 params.mode）；undefined = 隐藏分区。 */
  qualities?: VideoQuality[];
  /** 是否支持「生成音频」开关（params.generate_audio）。 */
  supportsAudio: boolean;
  /** 是否支持参考视频（params.reference_videos）。 */
  supportsReferenceVideo: boolean;
  /** 是否支持参考音频（params.reference_audios）。 */
  supportsReferenceAudio: boolean;
  /** 首尾帧模式开放的帧槽数：2=首+尾，1=仅首帧（happyhorse i2v），0=纯文生（t2v）。 */
  maxFrames: 0 | 1 | 2;
  /** 参考素材上限覆盖（缺省用 9/3/3 全局常量；happyhorse video-edit = 5 图 + 1 视频）。 */
  maxRefImages?: number;
  maxRefVideos?: number;
}

// Seedance 官方档位（provider-config.md「视频契约 — Seedance」）：
// duration 任意整数秒 2.0=[4,15] / 1.5pro=[4,12] / 1.0pro=[2,12]；
// ratio 七档含 adaptive（adaptive 全场景仅 2.0/1.5pro）；2.0-fast 无 1080p；
// 全能参考（图1-9+视频≤3+音频≤3）与音画同生仅 2.0 系；1.0pro 无音频。
const SEEDANCE_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'];

function durationRange(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

function seedanceCaps(id: string): VideoControlCaps {
  const is15 = id.includes('1-5') || id.includes('1.5');
  const is10 = id.includes('1-0') || id.includes('1.0');
  if (is15 || is10) {
    return {
      family: 'seedance',
      modes: ['firstlast'],
      durations: is15 ? durationRange(4, 12) : durationRange(2, 12),
      resolutions: ['480p', '720p', '1080p'],
      ratios: is15 ? SEEDANCE_RATIOS : SEEDANCE_RATIOS.filter((r) => r !== 'adaptive'),
      supportsAudio: is15,
      supportsReferenceVideo: false,
      supportsReferenceAudio: false,
      maxFrames: 2,
    };
  }
  // 2.0 系（含 2.0-fast 与未知 seedance 变体）
  return {
    family: 'seedance',
    modes: ['firstlast', 'omni'],
    durations: durationRange(4, 15),
    resolutions: id.includes('fast') ? ['480p', '720p'] : ['480p', '720p', '1080p'],
    ratios: SEEDANCE_RATIOS,
    supportsAudio: true,
    supportsReferenceVideo: true,
    supportsReferenceAudio: true,
    maxFrames: 2,
  };
}

// HappyHorse 官方档位（provider-config.md「视频契约 — HappyHorse」）：四模式 = 四个模型 id。
// resolution 大写 P；ratio 九档；duration [3,15]；i2v 仅首帧（ratio 随首帧）；
// r2v 参考图 1-9；video-edit 视频×1 + 参考图 0-5、无 duration/ratio。
const HAPPYHORSE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'];
const HAPPYHORSE_BASE = {
  family: 'happyhorse' as const,
  resolutions: ['720P', '1080P'],
  durations: durationRange(3, 15),
  supportsAudio: false,
  supportsReferenceVideo: false,
  supportsReferenceAudio: false,
};

function happyhorseCaps(id: string): VideoControlCaps {
  if (id.includes('video-edit')) {
    return {
      ...HAPPYHORSE_BASE,
      modes: ['omni'],
      durations: [],
      ratios: [],
      supportsReferenceVideo: true,
      maxFrames: 0,
      maxRefImages: 5,
      maxRefVideos: 1,
    };
  }
  if (id.includes('r2v')) {
    return { ...HAPPYHORSE_BASE, modes: ['omni'], ratios: HAPPYHORSE_RATIOS, maxFrames: 0 };
  }
  if (id.includes('i2v')) {
    return { ...HAPPYHORSE_BASE, modes: ['firstlast'], ratios: [], maxFrames: 1 };
  }
  // t2v（及未知 happyhorse 变体按纯文生兜底）
  return { ...HAPPYHORSE_BASE, modes: ['firstlast'], ratios: HAPPYHORSE_RATIOS, maxFrames: 0 };
}

// OpenRouter 视频 API 是统一异步 job，参数档位随底层厂商差异极大（kling 只 720p、
// veo 到 4K、时长枚举各不同）。duration/resolution 隐藏走厂商默认档，避免把某一家的
// 枚举错发给另一家（400）；比例只留全厂商交集三档。
const OPENROUTER_VIDEO_CAPS: VideoControlCaps = {
  family: 'openrouter',
  modes: ['firstlast', 'omni'],
  durations: [],
  resolutions: [],
  ratios: ['16:9', '9:16', '1:1'],
  supportsAudio: true,
  supportsReferenceVideo: false,
  supportsReferenceAudio: false,
  maxFrames: 2,
};

const STANDARD_CAPS: VideoControlCaps = {
  family: 'standard',
  modes: ['firstlast', 'omni'],
  durations: [5],
  resolutions: ['720p'],
  ratios: ['16:9', '9:16', '1:1'],
  supportsAudio: false,
  supportsReferenceVideo: false,
  supportsReferenceAudio: false,
  maxFrames: 2,
};

// openai-hk kling 文档（docs/lab/kling.html）：t2v/i2v 比例七档、时长 "5"/"10"、
// mode std/pro（v2-master 不支持、v2-6 固定 pro）、sound 仅 v2-6、o1 走 omni-video 端点。
const KLING_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'];

function klingCaps(id: string): VideoControlCaps {
  const isO1 = id.includes('o1');
  const isV26 = id.includes('v2-6');
  const isMaster = id.includes('master');
  return {
    family: 'kling',
    // 可灵无 seedance 那种全能参考矩阵：首尾帧模式覆盖 t2v（全空）/ i2v（image+image_tail）。
    modes: ['firstlast'],
    durations: [5, 10],
    resolutions: [],
    ratios: isO1 ? ['16:9', '9:16', '1:1'] : KLING_RATIOS,
    qualities: isV26 || isMaster ? undefined : ['std', 'pro'],
    supportsAudio: isV26,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
    maxFrames: 2,
  };
}

export function videoControlCaps(modelId?: string | null, protocol?: string | null): VideoControlCaps {
  const id = (modelId ?? '').toLowerCase();
  const p = protocol ?? '';
  // 显式协议优先：custom 模型 id 不含族关键词也能定族；id 仍用于族内分代（seedance 2.0 vs 1.5pro 等）。
  if (p === 'seedance') return seedanceCaps(id);
  if (p === 'dashscope') return happyhorseCaps(id);
  if (p === 'kling') return klingCaps(id);
  if (p === 'openrouter') return OPENROUTER_VIDEO_CAPS;
  // 无协议 → 退回按 modelId 子串识别（命名 provider 历史调用兼容）。
  if (id.includes('seedance')) return seedanceCaps(id);
  if (id.includes('happyhorse')) return happyhorseCaps(id);
  if (id.startsWith('kling')) return klingCaps(id);
  return STANDARD_CAPS;
}

/** 可灵生成档位的中文标签。 */
export const VIDEO_QUALITY_LABELS: Record<VideoQuality, string> = {
  std: '标准',
  pro: '专家',
};

/** 各生成方式的中文标签（VideoControls 汇总弹窗用）。 */
export const VIDEO_MODE_LABELS: Record<VideoMode, string> = {
  firstlast: '首尾帧',
  omni: '全能参考',
};

/** 比例的展示标签：adaptive 显示为中文，其余原样。 */
export function ratioLabel(ratio: string): string {
  return ratio === 'adaptive' ? '自适应' : ratio;
}
