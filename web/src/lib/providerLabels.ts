/** 厂商 provider → 官方中文/品牌名。未知 provider 回退到 alias。 */
export const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  chatgpt: 'ChatGPT（Codex 登录）',
  seedream: 'Volcengine Ark',
  tokendance: 'TokenDance',
  openrouter: 'OpenRouter',
  evolink: 'EvoLink',
  auto: '智能路由',
  atelier: '局域网',
};

export function providerLabel(provider?: string | null, alias?: string | null): string {
  if (provider && PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return alias || provider || '未知厂商';
}
