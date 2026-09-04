import { requestJson } from '@/api/http';

export type WorkshopGenerationTarget =
  | { type: 'character'; project_id: string; character_id: string; asset_slot: 'portrait' | 'promo' | 'turnaround' }
  | { type: 'ui'; project_id: string; ui_scheme_id: string; screen_id: string }
  | { type: 'video'; project_id: string; production_id: string };

export interface WorkshopRequest {
  request_id: string;
  revision: number;
  state: 'awaiting_approval' | 'approved' | 'withdrawn' | 'expired';
  target: WorkshopGenerationTarget;
  target_name: string;
  alias: string;
  provider: string;
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  references: { media_id: string; title: string; kind: string; sha256: string }[];
  estimated_cost_cny: number | null;
  price_basis: string;
  created_at: string;
  expires_at: string;
  job_id: string | null;
  job: { status: string; error: string | null; output_count: number } | null;
  execution_state: 'not_dispatched' | 'claimed' | 'needs_review';
  approval_url: string;
}
export function workshopTargetUrl(target: WorkshopGenerationTarget) {
  const project = encodeURIComponent(target.project_id);
  if (target.type === 'character') return `/workshop/${project}/art/characters/${encodeURIComponent(target.character_id)}/${target.asset_slot}`;
  if (target.type === 'ui') return `/workshop/${project}/ui/${encodeURIComponent(target.ui_scheme_id)}/screens/${encodeURIComponent(target.screen_id)}`;
  return `/workshop/${project}/video/${encodeURIComponent(target.production_id)}`;
}
export function workshopReferenceUrl(requestId: string, mediaId: string) {
  return `/api/workshop/requests/${encodeURIComponent(requestId)}/references/${encodeURIComponent(mediaId)}`;
}
export function fetchWorkshopRequest(requestId: string) {
  return requestJson<WorkshopRequest>(`/api/workshop/requests/${encodeURIComponent(requestId)}`, '读取生成请求');
}
export function fetchWorkshopRequests(page = 1) {
  return requestJson<{ requests: WorkshopRequest[]; page: number; page_size: number; total: number }>(
    `/api/workshop/requests?page=${page}&page_size=20`, '读取待批准生成',
  );
}
export function approveWorkshopRequest(request: WorkshopRequest) {
  return requestJson<WorkshopRequest>(`/api/workshop/requests/${encodeURIComponent(request.request_id)}/approve`, '批准生成', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: request.revision }),
  });
}
