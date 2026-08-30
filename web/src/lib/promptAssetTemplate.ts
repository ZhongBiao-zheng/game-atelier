import type { CreationPromptSegment } from '@/schema/creationAssets';

export interface PromptVariableRange {
  id: string;
  name: string;
  start: number;
  end: number;
}

export function promptTemplateFromSegments(segments: CreationPromptSegment[]): {
  text: string;
  variables: PromptVariableRange[];
} {
  let text = '';
  const variables: PromptVariableRange[] = [];
  segments.forEach((segment, index) => {
    if (segment.kind === 'text') {
      text += segment.text;
      return;
    }
    const start = text.length;
    text += segment.default_value;
    variables.push({
      id: `${index}-${segment.name}-${start}`,
      name: segment.name,
      start,
      end: text.length,
    });
  });
  return { text, variables };
}

export function segmentsFromPromptTemplate(
  text: string,
  ranges: PromptVariableRange[],
): CreationPromptSegment[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const segments: CreationPromptSegment[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor || range.end <= range.start || range.end > text.length) continue;
    if (range.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, range.start) });
    segments.push({
      kind: 'variable',
      name: range.name,
      default_value: text.slice(range.start, range.end),
    });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments.length ? segments : [{ kind: 'text', text }];
}

export function addPromptVariableRange(
  ranges: PromptVariableRange[],
  input: { name: string; start: number; end: number },
): PromptVariableRange[] {
  const name = input.name.trim();
  if (!name || input.end <= input.start) return ranges;
  if (ranges.some(range => input.start < range.end && input.end > range.start)) return ranges;
  return [...ranges, {
    id: `variable-${crypto.randomUUID()}`,
    name,
    start: input.start,
    end: input.end,
  }].sort((left, right) => left.start - right.start);
}

export function updatePromptVariableRanges(
  previousText: string,
  nextText: string,
  ranges: PromptVariableRange[],
): PromptVariableRange[] {
  let prefix = 0;
  while (
    prefix < previousText.length
    && prefix < nextText.length
    && previousText[prefix] === nextText[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < previousText.length - prefix
    && suffix < nextText.length - prefix
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix += 1;

  const previousEnd = previousText.length - suffix;
  const nextEnd = nextText.length - suffix;
  const delta = nextEnd - previousEnd;

  return ranges.flatMap(range => {
    if (previousEnd === prefix) {
      if (prefix < range.start) return [{ ...range, start: range.start + delta, end: range.end + delta }];
      if (prefix >= range.end) return [range];
      return [{ ...range, end: range.end + delta }];
    }
    if (range.end <= prefix) return [range];
    if (range.start >= previousEnd) {
      return [{ ...range, start: range.start + delta, end: range.end + delta }];
    }
    if (range.start <= prefix && range.end >= previousEnd) {
      const end = range.end + delta;
      return end > range.start ? [{ ...range, end }] : [];
    }
    return [];
  });
}
