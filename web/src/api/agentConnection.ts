import { requestJson } from '@/api/http';

export type AgentClient = 'claude-code' | 'codex';
export interface AgentStatus {
  enabled: boolean;
  /** 本次服务运行期间各宿主最近一次连上的时间（ISO）；服务重启后清空。 */
  connections: Partial<Record<AgentClient, string>>;
}

// 载荷不合契约就报错：直接读 connections[...] 会让整个设置页崩成黑屏（服务端没重启、还是旧接口时就会这样）。
function parse(value: unknown): AgentStatus {
  const status = value as Partial<AgentStatus> | null;
  if (typeof status?.enabled !== 'boolean' || typeof status.connections !== 'object' || status.connections === null) {
    throw new Error('读取 Agent 连接失败：返回格式不对，重启本机服务后再试');
  }
  return status as AgentStatus;
}

export async function fetchAgentStatus() {
  return parse(await requestJson<unknown>('/api/connection/agent', '读取 Agent 连接'));
}
/** 打开：签新凭据（Claude Code 插件直接读），装了 Codex 顺手写进它的配置。 */
export async function enableAgent() {
  return parse(await requestJson<unknown>('/api/connection/agent', '打开 Agent 连接', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  }));
}
export async function disableAgent() {
  return parse(await requestJson<unknown>('/api/connection/agent', '关闭 Agent 连接', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  }));
}
