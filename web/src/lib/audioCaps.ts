/**
 * 音频模型能力：协议 → 族（语音 / 音乐）与参数范围。
 *
 * 能力表与服务端共用 src/character_workflow/data/audio_caps.json；协议解析与参数归一
 * 与 audio_caps.py 逐条同义，由 tests/fixtures/audio_caps_cases.json 两端共同钉住。
 */
import raw from '@audio-caps';
import { availableDeclared, type ModelDeclared } from '@/schema/httpProtocols';

interface RawAudioCaps {
  family: string;
  voices?: { id: string; label: string }[];
  default_voice?: string;
  custom_voice?: boolean;
  speed?: number[];
  formats: string[];
  default_format: string;
  max_chars: number;
  instructions?: boolean;
  max_count?: number;
  max_lyrics_chars?: number;
  no_instrumental_models?: string[];
}

export interface AudioCaps {
  protocol: string;
  family: 'speech' | 'music';
  voices: readonly { id: string; label: string }[];
  defaultVoice: string;
  customVoice: boolean;
  speedMin: number;
  speedMax: number;
  formats: readonly string[];
  defaultFormat: string;
  /** 语音：朗读文本上限；音乐：描述上限。 */
  maxChars: number;
  instructions: boolean;
  /** 音乐：一次最多几首、歌词上限、哪些型号没有纯音乐。 */
  maxCount: number;
  maxLyricsChars: number;
  noInstrumentalModels: readonly string[];
  /** 自定义接口按模板声明：没声明的控件不出现；语速只有离散档位；可能没有纯音乐。 */
  controls: ReadonlySet<'voice' | 'speed' | 'format'>;
  speeds: readonly number[];
  instrumentalSupported: boolean;
}

const ALL_CONTROLS: ReadonlySet<'voice' | 'speed' | 'format'> = new Set(['voice', 'speed', 'format']);
/** 模板没写上限时的兜底，与服务端 DECLARED_MAX_CHARS / DECLARED_MAX_LYRICS 一致。 */
const DECLARED_MAX_CHARS = 20000;
const DECLARED_MAX_LYRICS = 5000;

export const AUDIO_CAPS: Readonly<Record<string, AudioCaps>> = Object.fromEntries(
  Object.entries(raw as Record<string, RawAudioCaps>).map(([protocol, caps]) => [protocol, {
    protocol,
    family: caps.family === 'music' ? 'music' : 'speech',
    voices: caps.voices ?? [],
    defaultVoice: caps.default_voice ?? '',
    customVoice: caps.custom_voice ?? false,
    speedMin: caps.speed?.[0] ?? 1,
    speedMax: caps.speed?.[1] ?? 1,
    formats: caps.formats,
    defaultFormat: caps.default_format,
    maxChars: caps.max_chars,
    instructions: caps.instructions ?? false,
    maxCount: caps.max_count ?? 1,
    maxLyricsChars: caps.max_lyrics_chars ?? 0,
    noInstrumentalModels: caps.no_instrumental_models ?? [],
    controls: ALL_CONTROLS,
    speeds: [],
    instrumentalSupported: true,
  }]),
);

/** 自定义接口的能力声明（本机模板或局域网快照）→ AudioCaps；与 audio_caps.declared_audio_caps 同义。 */
export function declaredAudioCaps(declared?: ModelDeclared | null): AudioCaps | null {
  const caps = availableDeclared(declared);
  if (!caps || caps.kind !== 'audio') return null;
  const voices = caps.voices ?? [];
  const speeds = caps.speeds ?? [];
  const formats = caps.formats ?? [];
  const controls = new Set<'voice' | 'speed' | 'format'>();
  if (voices.length) controls.add('voice');
  if (speeds.length) controls.add('speed');
  if (formats.length) controls.add('format');
  return {
    protocol: 'declarative',
    family: caps.family === 'music' ? 'music' : 'speech',
    voices,
    defaultVoice: voices[0]?.id ?? '',
    customVoice: Boolean(caps.custom_voice),
    speedMin: speeds.length ? Math.min(...speeds) : 1,
    speedMax: speeds.length ? Math.max(...speeds) : 1,
    formats,
    defaultFormat: formats[0] ?? '',
    maxChars: caps.max_chars || DECLARED_MAX_CHARS,
    instructions: false,
    maxCount: caps.max_count || 1,
    maxLyricsChars: caps.lyrics ? DECLARED_MAX_LYRICS : 0,
    noInstrumentalModels: [],
    controls,
    speeds,
    instrumentalSupported: Boolean(caps.instrumental),
  };
}

/** 任何协议的内置音色：换协议时它们不能被当成「自定义音色 ID」带过去。 */
const BUILTIN_VOICES = new Set(Object.values(AUDIO_CAPS).flatMap(caps => caps.voices.map(voice => voice.id)));
const OPENAI_SPEECH_ALIASES = new Set(['openai', 'openai-speech', 'tts', 'speech']);
const NON_SPEECH_ID_HINTS = ['asr', 'speech-to-text', 'speech2text', 'whisper'];
export const CUSTOM_VOICE_MAX_LENGTH = 200;
export const AUDIO_SPEED_PRESETS = [0.75, 1, 1.25, 1.5] as const;

/** 模型实际可执行的音频协议；null 表示当前版本跑不了它。局域网网关由调用方按成员判断。 */
export function audioProtocolOf(
  modelId: string,
  provider: string | null | undefined,
  protocol: string | null | undefined,
): string | null {
  if (protocol === 'declarative') return 'declarative';
  if (protocol && OPENAI_SPEECH_ALIASES.has(protocol)) return 'openai-speech';
  if (protocol && protocol in AUDIO_CAPS) return protocol;
  if (protocol != null || !['openai', 'custom'].includes(String(provider))) return null;
  const normalized = modelId.toLowerCase();
  if (NON_SPEECH_ID_HINTS.some(hint => normalized.includes(hint))) return null;
  return normalized.includes('tts') || normalized.includes('text-to-speech') ? 'openai-speech' : null;
}

export function audioCapsOf(
  modelId: string,
  provider: string | null | undefined,
  protocol: string | null | undefined,
  declared?: ModelDeclared | null,
): AudioCaps | null {
  const resolved = audioProtocolOf(modelId, provider, protocol);
  if (resolved === 'declarative') return declaredAudioCaps(declared);
  return resolved ? AUDIO_CAPS[resolved] : null;
}

function isPrintable(value: string) {
  // 与 Python str.isprintable 同义：除普通空格外，控制符与各类分隔符都不算。
  return [...value].every(ch => ch === ' ' || !/[\p{C}\p{Z}]/u.test(ch));
}

export function isCustomVoice(caps: AudioCaps, value: string) {
  return caps.customVoice
    && value.length > 0
    && value.length <= CUSTOM_VOICE_MAX_LENGTH
    && !BUILTIN_VOICES.has(value)
    && isPrintable(value);
}

export type SpeechParams = {
  voice?: string;
  response_format?: string;
  speed?: number;
  instructions?: string;
};

/** 按协议能力收拢语音参数：内置音色或合法自定义 ID，语速夹到范围内，格式不认识回默认。 */
export function normalizeSpeechParams(caps: AudioCaps, params: Record<string, unknown>): SpeechParams {
  const rawVoice = String(params.voice ?? '').trim();
  const voice = caps.voices.some(item => item.id === rawVoice) || isCustomVoice(caps, rawVoice)
    ? rawVoice
    : caps.defaultVoice;
  const rawFormat = String(params.response_format ?? '').toLowerCase();
  const responseFormat = caps.formats.includes(rawFormat) ? rawFormat : caps.defaultFormat;
  const parsed = params.speed == null || params.speed === '' ? 1 : Number(params.speed);
  const speed = Number.isFinite(parsed) ? parsed : 1;
  let clamped = Number(Math.max(caps.speedMin, Math.min(caps.speedMax, speed)).toFixed(2));
  if (caps.speeds.length) {
    // 离散档位：吸附到最近一档（同距取较慢的那档）。
    clamped = caps.speeds.reduce((best, value) => {
      const gap = Math.abs(value - clamped) - Math.abs(best - clamped);
      return gap < 0 || (gap === 0 && value < best) ? value : best;
    });
  }
  const normalized = {} as SpeechParams;
  if (caps.controls.has('voice')) normalized.voice = voice;
  if (caps.controls.has('format')) normalized.response_format = responseFormat;
  if (caps.controls.has('speed')) normalized.speed = clamped;
  const instructions = String(params.instructions ?? '').trim();
  if (caps.instructions && instructions) normalized.instructions = instructions;
  return normalized;
}

export function audioVoiceLabel(caps: AudioCaps, voice: string) {
  return caps.voices.find(item => item.id === voice)?.label ?? voice;
}

const FORMAT_LABELS: Record<string, string> = {
  mp3: 'MP3', wav: 'WAV', opus: 'Opus', aac: 'AAC', flac: 'FLAC', pcm: 'PCM',
};

export function audioFormatLabel(format: string) {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

export function audioSpeedLabel(speed: number) {
  return `${speed}x`;
}

export function supportsInstrumental(caps: AudioCaps, modelId: string) {
  return caps.family === 'music' && caps.instrumentalSupported && !caps.noInstrumentalModels.includes(modelId);
}

export type MusicParams = { instrumental: boolean; n: number; lyrics?: string };

/** 音乐参数：纯音乐（型号不支持就关）、歌词（纯音乐时不发）、首数夹到 1..上限。与 audio_caps.normalize_music_params 同义。
 *  歌词超长这里不截断：输入框按上限限制，服务端拒绝超长内容。 */
export function normalizeMusicParams(caps: AudioCaps, modelId: string, params: Record<string, unknown>): MusicParams {
  const instrumental = params.instrumental === true && supportsInstrumental(caps, modelId);
  const parsed = Math.trunc(Number(params.n || 1));
  const count = Number.isFinite(parsed) ? parsed : 1;
  const normalized: MusicParams = { instrumental, n: Math.max(1, Math.min(caps.maxCount, count)) };
  const lyrics = String(params.lyrics ?? '').trim();
  if (lyrics && !instrumental && caps.maxLyricsChars > 0) normalized.lyrics = lyrics;
  return normalized;
}
