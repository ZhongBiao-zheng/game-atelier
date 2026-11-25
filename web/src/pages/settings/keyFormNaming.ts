import { ApiError } from '@/api/http';
import { errorText } from '@/lib/errorText';
import { PROVIDER_PRESETS, providerPresetId } from './providerPresets';

/** 表单里的一条报错：一句原因 + 可展开的原文（规格 2.2，原文默认收起）。 */
export interface FormIssue {
  message: string;
  raw: string | null;
  code: string | null;
}

export function toIssue(error: unknown): FormIssue {
  return {
    message: errorText(error),
    raw: error instanceof ApiError ? error.raw : null,
    code: error instanceof ApiError ? error.code : null,
  };
}

/** 名称留空时的默认名：自定义供应商按地址认品牌，认不出用 host；其他用预置名。 */
export function defaultAliasBase({ presetId, presetLabel, baseUrl }: {
  presetId: string; presetLabel: string; baseUrl: string;
}): string {
  if (presetId !== 'custom') return presetLabel;
  const known = providerPresetId({ provider: 'custom', base_url: baseUrl });
  if (known !== 'custom') return PROVIDER_PRESETS.find(preset => preset.id === known)?.label ?? '';
  try { return new URL(baseUrl).hostname; } catch { return ''; }
}

/** 名称是否已被占用。自带 provider 的预置（openai、tokendance…）第一把的别名就是 provider 本身，
 *  所以预置名在 provider 已被用掉时也算占用。 */
export function aliasTaken(name: string, taken: ReadonlySet<string>, reserved?: { label: string; provider: string }): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  for (const alias of taken) if (alias.toLowerCase() === key) return true;
  return Boolean(reserved && key === reserved.label.toLowerCase() && aliasTaken(reserved.provider, taken));
}

/** 同一预置多把密钥（D15）：「TokenDance」被占用就依次试「TokenDance 2」「TokenDance 3」…… */
export function nextFreeAlias(base: string, taken: ReadonlySet<string>, reserved?: { label: string; provider: string }): string {
  if (!base) return '';
  if (!aliasTaken(base, taken, reserved)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!aliasTaken(candidate, taken, reserved)) return candidate;
  }
}
