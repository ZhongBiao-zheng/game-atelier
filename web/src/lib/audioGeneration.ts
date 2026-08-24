export const AUDIO_VOICE_OPTIONS = [
  { value: 'alloy', label: 'Alloy' },
  { value: 'ash', label: 'Ash' },
  { value: 'ballad', label: 'Ballad' },
  { value: 'coral', label: 'Coral' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'nova', label: 'Nova' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'sage', label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse', label: 'Verse' },
  { value: 'marin', label: 'Marin' },
  { value: 'cedar', label: 'Cedar' },
] as const;

export const AUDIO_FORMAT_OPTIONS = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV' },
  { value: 'opus', label: 'Opus' },
  { value: 'aac', label: 'AAC' },
  { value: 'flac', label: 'FLAC' },
  { value: 'pcm', label: 'PCM' },
] as const;

export const AUDIO_SPEED_PRESETS = [0.75, 1, 1.25, 1.5] as const;

export function normalizeAudioVoice(value: unknown) {
  const normalized = String(value ?? '').toLowerCase();
  return AUDIO_VOICE_OPTIONS.some(option => option.value === normalized) ? normalized : 'alloy';
}

export function normalizeAudioFormat(value: unknown) {
  const normalized = String(value ?? '').toLowerCase();
  return AUDIO_FORMAT_OPTIONS.some(option => option.value === normalized) ? normalized : 'mp3';
}

export function normalizeAudioSpeed(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Number(Math.max(0.25, Math.min(4, parsed)).toFixed(2));
}

export function audioVoiceLabel(value: unknown) {
  const normalized = normalizeAudioVoice(value);
  return AUDIO_VOICE_OPTIONS.find(option => option.value === normalized)?.label ?? normalized;
}

export function audioFormatLabel(value: unknown) {
  const normalized = normalizeAudioFormat(value);
  return AUDIO_FORMAT_OPTIONS.find(option => option.value === normalized)?.label ?? normalized;
}

export function audioSpeedLabel(value: unknown) {
  return `${normalizeAudioSpeed(value)}x`;
}
