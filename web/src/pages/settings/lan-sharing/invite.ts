/** 团队网关邀请：主机把地址和成员密钥拼成一段可直接转发的文字，成员粘贴到表单任一框里自动拆开。 */

const ADDRESS = /https?:\/\/[^\s"'<>，。]+/i;
const TOKEN = /\batg_[A-Za-z0-9_-]+/;

export function formatGatewayInvite(address: string, token: string): string {
  return `Cobrush 团队网关邀请\n地址：${address}\n密钥：${token}`;
}

/** 文字里同时有网关地址和 atg_ 密钥才算邀请；只有其一时返回 null，按普通粘贴处理。 */
export function parseGatewayInvite(text: string): { baseUrl: string; token: string } | null {
  const address = text.match(ADDRESS)?.[0];
  const token = text.match(TOKEN)?.[0];
  if (!address || !token) return null;
  return { baseUrl: address.replace(/\/+$/, ''), token };
}
