import { requestJson } from './http';
import { remoteProjectPath } from './collab';
import type { CanvasDocument, CanvasFrozenGeneration } from '@/schema/canvas';

function post<T>(url: string, label: string, body: object): Promise<T> {
  return requestJson<T>(url, label, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

export function copySharedNodes(peerKey: string, projectId: string, nodeIds: string[], target: string, revision?: number) {
  return post<CanvasDocument>(remoteProjectPath(peerKey, projectId) + '/copy-to-local', '复制节点', {
    node_ids: nodeIds, target_project_id: target, document_revision: revision,
  });
}

export function shareStudioResult(jobId: string, index: number, peerKey: string, projectId: string) {
  return post(`/api/studio/jobs/${encodeURIComponent(jobId)}/shared-canvas`, '投送创作台结果', {
    output_index: index, peer_key: peerKey, project_id: projectId,
  });
}

export function sharedStudioReference(peerKey: string, projectId: string, versionId: string) {
  return post<{path: string; frozen_generation: CanvasFrozenGeneration | null}>(
    remoteProjectPath(peerKey, projectId) + '/send-to-studio', '发送到创作台', { version_id: versionId });
}

export function reproduceFrozen(projectId: string, versionId: string, revision: number,
  position: {x: number; y: number}, alias: string | null, model: string | null) {
  return post<CanvasDocument>(`/api/canvas/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/reproduce`,
    '复刻生成', { document_revision: revision, position, alias, model });
}
