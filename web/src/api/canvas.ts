import { request, requestJson } from './http';
import type { Job } from '@/schema/jobs';
import type {
  CanvasAgentSession,
  CanvasAgentSessionList,
  CanvasDocument,
  CanvasMediaOperation,
  CanvasMediaOperationResult,
  CanvasPackageImport,
  CanvasPackageInspection,
  CanvasProject,
  CanvasProjectSummary,
  CanvasRun,
  CanvasUpload,
} from '@/schema/canvas';

export function listCanvasProjects(lightweight: true): Promise<CanvasProject[]>;
export function listCanvasProjects(lightweight?: false): Promise<CanvasProjectSummary[]>;
export async function listCanvasProjects(
  lightweight = false,
): Promise<CanvasProject[] | CanvasProjectSummary[]> {
  if (lightweight) {
    return requestJson<CanvasProject[]>('/api/canvas/project-options', '读取画布项目选项');
  }
  const data = await requestJson<{ projects: CanvasProjectSummary[] }>(
    '/api/canvas/projects',
    '读取画布项目',
  );
  return data.projects;
}

export function createCanvasProject(name: string): Promise<CanvasProject> {
  return requestJson<CanvasProject>('/api/canvas/projects', '创建画布项目', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameCanvasProject(projectId: string, name: string): Promise<CanvasProject> {
  return requestJson<CanvasProject>(`/api/canvas/projects/${encodeURIComponent(projectId)}`, '重命名画布项目', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function listCanvasAgentSessions(projectId: string): Promise<CanvasAgentSessionList> {
  return requestJson<CanvasAgentSessionList>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/agent/sessions`,
    '读取画布 Agent 会话',
  );
}

export function createCanvasAgentSession(
  projectId: string,
  title: string,
): Promise<CanvasAgentSession> {
  return requestJson<CanvasAgentSession>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/agent/sessions`,
    '创建画布 Agent 会话',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    },
  );
}

export function getCanvasAgentSession(
  projectId: string,
  sessionId: string,
): Promise<CanvasAgentSession> {
  return requestJson<CanvasAgentSession>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/agent/sessions/${encodeURIComponent(sessionId)}`,
    '读取画布 Agent 会话',
  );
}

export function deleteCanvasAgentSession(
  projectId: string,
  sessionId: string,
  revision: number,
): Promise<void> {
  return request(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/agent/sessions/${encodeURIComponent(sessionId)}`,
    '删除画布 Agent 会话',
    { method: 'DELETE', headers: { 'If-Match': String(revision) } },
  ).then(() => undefined);
}

export async function exportCanvasProjects(projectIds: string[]): Promise<void> {
  const response = await request('/api/canvas/projects/export', '导出画布项目', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_ids: projectIds }),
  });
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const filename = encodedName
    ? decodeURIComponent(encodedName)
    : plainName ?? '画布项目.game-atelier-canvas.zip';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function inspectCanvasPackage(file: File): Promise<CanvasPackageInspection> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<CanvasPackageInspection>(
    '/api/canvas/projects/import/inspect',
    '校验 Canvas 项目包',
    { method: 'POST', body: form },
  );
}

export function commitCanvasPackage(token: string): Promise<CanvasPackageImport> {
  return requestJson<CanvasPackageImport>(
    '/api/canvas/projects/import/commit',
    '导入 Canvas 项目包',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
}

export function deleteCanvasProject(
  projectId: string,
  expectedRevision: number,
): Promise<void> {
  return request(
    `/api/canvas/projects/${encodeURIComponent(projectId)}`,
    '删除画布项目',
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  ).then(() => undefined);
}

export function getCanvasDocument(projectId: string): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/document`,
    '读取画布',
  );
}

export function saveCanvasDocument(projectId: string, document: CanvasDocument): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/document`,
    '保存画布',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'If-Match': String(document.revision) },
      body: JSON.stringify(document),
    },
  );
}

export async function uploadCanvasMedia(
  projectId: string,
  file: File,
  expectedRevision: number,
): Promise<CanvasUpload> {
  const form = new FormData();
  form.append('file', file);
  form.append('expected_revision', String(expectedRevision));
  return requestJson<CanvasUpload>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/uploads`,
    '上传画布资源',
    { method: 'POST', body: form },
  );
}

export async function replaceCanvasNodeMedia(
  projectId: string,
  nodeId: string,
  file: File,
  expectedRevision: number,
): Promise<CanvasUpload> {
  const form = new FormData();
  form.append('file', file);
  form.append('expected_revision', String(expectedRevision));
  return requestJson<CanvasUpload>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/replace`,
    '上传或替换画布媒体',
    { method: 'POST', body: form },
  );
}

/** 与后端 `canvas_thumbnails.CANVAS_THUMBNAIL_WIDTHS` 同一组档位。
 *
 *  两边都取档是有原因的：服务端取档是为了不让调用方无限往磁盘写派生文件；客户端取档是为了
 *  让 URL 只有这几个取值——否则拖动节点边框时每一帧都是一个新 URL，浏览器会把同一张图重新
 *  拉几十遍。真值在服务端，这份副本漂了也只是档位选大一档，不会改变看到的内容。 */
const CANVAS_THUMBNAIL_WIDTHS = [256, 512, 1024];

/** 把「这张图会显示成多宽」换算成要向服务端申请的位图宽度；超过最大档位返回 null＝要原图。 */
function canvasThumbnailWidth(displayWidth: number): number | null {
  const ratio = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const needed = displayWidth * ratio;
  return CANVAS_THUMBNAIL_WIDTHS.find(candidate => needed <= candidate) ?? null;
}

/** displayWidth 传的是 CSS 像素下的显示宽度，不是想要的位图尺寸——设备像素比和档位都由这里算。
 *  不传＝要原图（全屏预览、蒙版编辑、下载这类地方）。 */
export function canvasMediaUrl(
  projectId: string,
  versionId: string,
  displayWidth?: number,
): string {
  const base = `/api/canvas/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/media`;
  if (displayWidth === undefined || displayWidth <= 0) return base;
  const width = canvasThumbnailWidth(displayWidth);
  return width === null ? base : `${base}?w=${width}`;
}

export function canvasDownloadUrl(
  projectId: string,
  versionId: string,
): string {
  return `/api/canvas/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/download`;
}

export function runCanvasMediaOperation(
  projectId: string,
  sourceNodeId: string,
  sourceVersionId: string,
  expectedRevision: number,
  operation: CanvasMediaOperation,
): Promise<CanvasMediaOperationResult> {
  return requestJson<CanvasMediaOperationResult>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/media-operations`,
    '处理画布图片',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_revision: expectedRevision,
        source_node_id: sourceNodeId,
        source_version_id: sourceVersionId,
        operation,
      }),
    },
  );
}

export function listCanvasJobs(projectId: string): Promise<Job[]> {
  return requestJson<Job[]>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/jobs`,
    '读取画布生成任务',
  );
}

export function submitCanvasRun(
  projectId: string,
  surfaceNodeId: string,
  expectedRevision: number,
  requestedCount: number,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs`,
    '提交画布生成',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface_node_id: surfaceNodeId,
        expected_revision: expectedRevision,
        requested_count: requestedCount,
      }),
    },
  );
}

export function submitCanvasReversePrompt(
  projectId: string,
  surfaceNodeId: string,
  expectedRevision: number,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/reverse-prompt`,
    '反推图片提示词',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface_node_id: surfaceNodeId,
        expected_revision: expectedRevision,
      }),
    },
  );
}

export function submitCanvasMaskEdit(
  projectId: string,
  surfaceNodeId: string,
  expectedRevision: number,
  requestedCount: number,
  mask: Blob,
): Promise<CanvasRun> {
  const form = new FormData();
  form.append('surface_node_id', surfaceNodeId);
  form.append('expected_revision', String(expectedRevision));
  form.append('requested_count', String(requestedCount));
  form.append('mask_file', mask, 'mask.png');
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/mask-edit`,
    '提交局部编辑',
    { method: 'POST', body: form },
  );
}

export interface CanvasAngleRunPayload {
  surface_node_id: string;
  expected_revision: number;
  requested_count: number;
  horizontal_angle: number;
  pitch_angle: number;
  camera_distance: number;
  wide_angle: boolean;
}

export function submitCanvasAngleRun(
  projectId: string,
  payload: CanvasAngleRunPayload,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/angle`,
    '提交多角度生成',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

export function createCanvasReversePromptConfig(
  projectId: string,
  runId: string,
  expectedRevision: number,
): Promise<CanvasDocument> {
  return requestJson<CanvasDocument>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/reverse-prompt-config`,
    '创建反推图片配置',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  );
}

export function retryCanvasRun(
  projectId: string,
  runId: string,
  expectedRevision: number,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/retry`,
    '按当前设置再次生成',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  );
}

export function cancelCanvasRun(projectId: string, runId: string): Promise<Job> {
  return requestJson<Job>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    '停止画布生成',
    { method: 'POST' },
  );
}

export function dismissCanvasCandidate(
  projectId: string,
  runId: string,
  candidateId: string,
  expectedRevision: number,
): Promise<CanvasRun> {
  return requestJson<CanvasRun>(
    `/api/canvas/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}/dismiss`,
    '删除候选槽位',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  );
}
