/** 厂商 provider → 官方中文/品牌名。未知 provider 回退到 alias。 */
export const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  seedream: '火山引擎',
  tokendance: '词元跳动',
  openrouter: 'OpenRouter',
};

export function providerLabel(provider?: string | null, alias?: string | null): string {
  if (provider && PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return alias || provider || '未知厂商';
}
