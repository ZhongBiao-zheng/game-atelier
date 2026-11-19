import { requestJson } from '@/api/http';

/** 与服务端 viewer_server.agent_clients.CLIENT_IDS 同序。 */
export const AGENT_CLIENTS = ['claude-code', 'codex', 'cursor', 'claude-desktop', 'trae', 'workbuddy'] as const;
export type AgentClient = typeof AGENT_CLIENTS[number];
/** write：一键写入；copy：只给配置片段；plugin：Claude Code 已装 Atelier 插件。 */
export type AgentClientMode = 'write' | 'copy' | 'plugin';
export interface AgentClientRow {
  id: AgentClient;
  mode: AgentClientMode;
  /** 配置文件位置；copy 类为 null。 */
  path: string | null;
  /** 配置里我们那一条已是本次服务的启动命令。 */
  written: boolean;
  snippet: string;
  /** 这份配置在该客户端用不了的原因（TRAE：命令路径含空格）。 */
  warning: string | null;
}
export interface AgentStatus {
  enabled: boolean;
  /** 本次服务运行期间各宿主最近一次连上的时间（ISO）；服务重启后清空。 */
  connections: Partial<Record<AgentClient, string>>;
  credential_path: string;
  clients: AgentClientRow[];
  tools: { name: string; billable: boolean }[];
}

const isClient = (value: unknown): value is AgentClient => AGENT_CLIENTS.includes(value as AgentClient);

// 载荷不合契约就报错：直接读 connections[...] 会让整个设置页崩成黑屏（服务端没重启、还是旧接口时就会这样）。
function parse(value: unknown): AgentStatus {
  const status = value as Partial<AgentStatus> | null;
  const connections = status?.connections;
  const connectionsOk = typeof connections === 'object' && connections !== null && !Array.isArray(connections)
    && Object.entries(connections).every(([key, at]) => isClient(key) && typeof at === 'string');
  const clientsOk = Array.isArray(status?.clients) && status.clients.every(row => row !== null && typeof row === 'object'
    && isClient(row.id) && ['write', 'copy', 'plugin'].includes(row.mode)
    && (row.path === null || typeof row.path === 'string') && typeof row.written === 'boolean'
    && typeof row.snippet === 'string' && (row.warning === null || typeof row.warning === 'string'));
  if (typeof status?.enabled !== 'boolean' || !connectionsOk || !clientsOk || typeof status.credential_path !== 'string'
    || !Array.isArray(status.tools) || !status.tools.every(tool => tool !== null && typeof tool === 'object'
      && typeof tool.name === 'string' && typeof tool.billable === 'boolean')) {
    throw new Error('读取 Agent 连接失败：返回格式不对，重启本机服务后再试');
  }
  return status as AgentStatus;
}

const json = (body: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function fetchAgentStatus() {
  return parse(await requestJson<unknown>('/api/connection/agent', '读取 Agent 连接'));
}
/** 打开：签新凭据（Claude Code 插件直接读），装了 Codex 顺手写进它的配置。 */
export async function enableAgent() {
  return parse(await requestJson<unknown>('/api/connection/agent', '打开 Agent 连接', { method: 'PUT', ...json({}) }));
}
export async function disableAgent() {
  return parse(await requestJson<unknown>('/api/connection/agent', '关闭 Agent 连接', { method: 'DELETE', ...json({}) }));
}
/** 把适配器写进某个客户端的配置（只动我们那一条，写前备份）。 */
export async function writeAgentClientConfig(client: AgentClient) {
  return parse(await requestJson<unknown>('/api/connection/agent/client-config', '写入客户端配置',
    { method: 'POST', ...json({ client }) }));
}
