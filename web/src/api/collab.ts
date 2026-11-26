import type { CollabCard, CollabDocument, CollabSettings } from '@/schema/collab';
import { request, requestJson } from './http';

const base = '/api/collab';
const sendJson = (method: string, body: unknown) => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export function remoteProjectPath(peerKey: string, projectId: string) {
  return `${base}/remote/${encodeURIComponent(peerKey)}/projects/${encodeURIComponent(projectId)}`;
}

export async function listCollabPeers(): Promise<CollabCard[]> {
  const { shares } = await requestJson<{shares: CollabCard[]}>(`${base}/peers`, '读取共享画布');
  return shares;
}

export function readCollabStatus() {
  return requestJson<{running: boolean; port: number | null; addresses: string[]; share_count: number}>(
    `${base}/status`, '读取共享状态',
  );
}

export async function updateCollabShare(projectId: string, settings: CollabSettings) {
  await request(`${base}/shares/${encodeURIComponent(projectId)}`, '保存共享设置', sendJson('PUT', settings));
}

export async function stopCollabShare(projectId?: string) {
  if (projectId) await request(`${base}/shares/${encodeURIComponent(projectId)}`, '停止共享', {method: 'DELETE'});
  else await request(`${base}/shares/stop-all`, '停止全部共享', {method: 'POST'});
}

export async function connectCollabPeer(address: string) {
  await request(`${base}/peers/manual`, '连接共享画布', sendJson('POST', {address}));
}

export async function authenticateCollab(peerKey: string, projectId: string, passcode?: string) {
  await request(`${remoteProjectPath(peerKey, projectId)}/auth`, '进入共享画布', sendJson('POST', {passcode}));
}

export function getRemoteDocument(peerKey: string, projectId: string) {
  return requestJson<CollabDocument>(`${remoteProjectPath(peerKey, projectId)}/document`, '读取共享画布');
}

export function remoteMediaUrl(peerKey: string, projectId: string, versionId: string, thumb = false) {
  return `${remoteProjectPath(peerKey, projectId)}/versions/${encodeURIComponent(versionId)}/media?thumb=${thumb ? 1 : 0}`;
}
