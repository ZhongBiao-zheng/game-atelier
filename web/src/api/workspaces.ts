import { requestJson } from './http';

export type WorkflowDocumentStatus = 'missing' | 'draft' | 'approved' | string;

export interface UiScreenSummary {
  screen_id: string;
  name: string;
  category: string;
  priority: string;
  status: string;
  dependency: string;
  purpose: string;
  brief_summary: string;
}

export interface ProjectWorkspaceSummary {
  project_id: string;
  art: {
    characters: number;
    canonical: number;
    stale: number;
  };
  ui: {
    scheme_id: string;
    anchors: Record<'gdd' | 'prd' | 'interaction', WorkflowDocumentStatus>;
    anchors_approved: number;
    style_status: WorkflowDocumentStatus;
    has_ui_style: boolean;
    screen_map_status: WorkflowDocumentStatus;
    screens: number;
    versions: number;
    canonical: number;
    stale: number;
    screen_items: UiScreenSummary[];
    next_action: string;
    next_command: string;
  };
  video: {
    productions: number;
    versions: number;
    selected: number;
    next_action: string;
  };
}

export async function fetchProjectWorkspaces(
  projectId: string,
  uiSchemeId?: string,
): Promise<ProjectWorkspaceSummary> {
  const query = uiSchemeId ? `?ui_scheme=${encodeURIComponent(uiSchemeId)}` : '';
  const data = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/workspaces${query}`,
    '读取项目工作流进度',
  );
  if (!isWorkspaceSummary(data)) throw new Error('项目工作流进度格式不正确');
  return data;
}

function isWorkspaceSummary(value: unknown): value is ProjectWorkspaceSummary {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<ProjectWorkspaceSummary>;
  return Boolean(
    data.art && typeof data.art.characters === 'number'
    && data.ui && typeof data.ui.anchors_approved === 'number'
    && typeof data.ui.next_action === 'string'
    && data.video && typeof data.video.productions === 'number',
  );
}
