export type MentionKind = 'image' | 'video' | 'audio';

const MENTION_TOKEN_PATTERN = '(图片|图|视频|音频)(\\d+)';

export function createMentionTokenRegex(optionalAt = false): RegExp {
  return new RegExp(`${optionalAt ? '@?' : '@'}${MENTION_TOKEN_PATTERN}`, 'g');
}

export function mentionKindFromToken(token: string): MentionKind {
  if (token === '视频') return 'video';
  if (token === '音频') return 'audio';
  return 'image';
}

export function mentionLabelForKind(kind: MentionKind): string {
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '图';
}

export function canonicalMentionLabel(token: string, index: string | number): string {
  return `${mentionLabelForKind(mentionKindFromToken(token))}${index}`;
}

export function mentionTokenPatternForLabel(label: string): string {
  return label === '图' ? '(?:图片|图)' : label;
}
