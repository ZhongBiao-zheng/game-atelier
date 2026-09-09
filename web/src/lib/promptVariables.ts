import type { CreationPromptSegment } from '@/schema/creationAssets';

export interface PromptVariable { name: string; example: string; value: string }
type PromptPart = { kind: 'text'; text: string } | { kind: 'variable'; variable: PromptVariable };
const PREFIX = '@[variable:';

export function promptVariableToken(variable: PromptVariable): string {
  return `${PREFIX}${encodeURIComponent(JSON.stringify(variable))}]`;
}

export function promptVariableParts(prompt: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let end = 0;
  for (const match of prompt.matchAll(/@\[variable:([^\]]*)\]/g)) {
    let variable: PromptVariable;
    try {
      variable = JSON.parse(decodeURIComponent(match[1]));
      if (!variable || typeof variable.name !== 'string' || !variable.name.trim()
        || typeof variable.example !== 'string' || typeof variable.value !== 'string'
        || Object.keys(variable).sort().join(',') !== 'example,name,value') continue;
    } catch { continue; }
    if (match.index! > end) parts.push({ kind: 'text', text: prompt.slice(end, match.index) });
    parts.push({ kind: 'variable', variable });
    end = match.index! + match[0].length;
  }
  if (end < prompt.length) parts.push({ kind: 'text', text: prompt.slice(end) });
  return parts;
}

export function promptFromAsset(segments: readonly CreationPromptSegment[]): string {
  return segments.map(segment => segment.kind === 'text' ? segment.text : promptVariableToken({
    name: segment.name, example: segment.default_value, value: '',
  })).join('');
}

/** Empty examples are not values. Reject damaged tokens before submitting. */
export function promptVariableError(prompt: string): string | null {
  const values = new Map<string, string>();
  const missing = new Set<string>();
  for (const part of promptVariableParts(prompt)) {
    if (part.kind === 'text') {
      if (part.text.includes(PREFIX)) return '提示词变量格式无效，请重新使用提示词资产';
      continue;
    }
    const { name, value } = part.variable;
    if (!value.trim()) missing.add(name);
    if (values.has(name) && values.get(name) !== value) return `变量「${name}」的内容不一致`;
    values.set(name, value);
  }
  return missing.size ? `请填写：${[...missing].join('、')}` : null;
}

export function resolvePromptVariables(prompt: string): string {
  const error = promptVariableError(prompt);
  if (error) throw new Error(error);
  return promptVariableParts(prompt).map(part => part.kind === 'text' ? part.text : part.variable.value).join('');
}

/** Copy/export is human-readable; persistence uses the original tokens. */
export function readablePromptVariables(prompt: string): string {
  return promptVariableParts(prompt).map(part => part.kind === 'text' ? part.text : part.variable.value || `[${part.variable.name}]`).join('');
}

export function promptToAssetSegments(prompt: string): CreationPromptSegment[] {
  return promptVariableParts(prompt).map(part => part.kind === 'text' ? part : {
    kind: 'variable', name: part.variable.name,
    default_value: part.variable.value || part.variable.example || part.variable.name,
  });
}
