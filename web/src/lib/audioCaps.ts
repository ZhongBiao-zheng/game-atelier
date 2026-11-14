/**
 * 音频模型能力：协议 → 族（语音 / 音乐）与参数范围。
 *
 * 能力表与服务端共用 src/character_workflow/data/audio_caps.json；协议解析与参数归一
 * 与 audio_caps.py 逐条同义，由 tests/fixtures/audio_caps_cases.json 两端共同钉住。
 */
import raw from '@audio-caps';

interface RawAudioCaps {
  family: string;
  voices: { id: string; label: string }[];
  default_voice: string;
  custom_voice: boolean;
  speed: number[];
  formats: string[];
  default_format: string;
  max_chars: number;
  instructions: boolean;
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
  maxChars: number;
  instructions: boolean;
}

export const AUDIO_CAPS: Readonly<Record<string, AudioCaps>> = Object.fromEntries(
  Object.entries(raw as Record<string, RawAudioCaps>).map(([protocol, caps]) => [protocol, {
    protocol,
    family: caps.family === 'music' ? 'music' : 'speech',
    voices: caps.voices,
    defaultVoice: caps.default_voice,
    customVoice: caps.custom_voice,
    speedMin: caps.speed[0],
    speedMax: caps.speed[1],
    formats: caps.formats,
    defaultFormat: caps.default_format,
    maxChars: caps.max_chars,
    instructions: caps.instructions,
  }]),
);

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
): AudioCaps | null {
  const resolved = audioProtocolOf(modelId, provider, protocol);
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
  voice: string;
  response_format: string;
  speed: number;
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
  const normalized: SpeechParams = {
    voice,
    response_format: responseFormat,
    speed: Number(Math.max(caps.speedMin, Math.min(caps.speedMax, speed)).toFixed(2)),
  };
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
