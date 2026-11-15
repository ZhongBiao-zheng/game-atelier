import type { ParsedStoryboardSegment } from '@/lib/canvasStoryboard';

import { requestJson } from './http';

function json(body: unknown) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function projectBase(projectId: string) {
  return `/api/canvas/projects/${encodeURIComponent(projectId)}/storyboard`;
}

/** 剧本解析可用的对话模型；max_cost_cny 是解析一段的最高花费，null 为未计价。 */
export interface StoryboardParseModel { alias: string; model_id: string; name: string; max_cost_cny: number | null }

export interface StoryboardParsePlan {
  total_chars: number;
  segments: Array<{ index: number; chars: number; preview: string }>;
}

export interface StoryboardParseResult extends ParsedStoryboardSegment {
  segment_index: number;
  segment_count: number;
  notices: string[];
  usage: { input_tokens: number | null; output_tokens: number | null; cost_cny: number | null; job_id: string };
}

export function listStoryboardParseModels() {
  return requestJson<{ models: StoryboardParseModel[] }>('/api/canvas/storyboard/models', '读取对话模型');
}

/** 不计费：按已保存的剧本算出要分几段。 */
export function planStoryboardParse(projectId: string, scriptNodeIds: readonly string[]) {
  return requestJson<StoryboardParsePlan>(`${projectBase(projectId)}/plan`, '读取剧本',
    json({ script_node_ids: scriptNodeIds }));
}

/** 计费调用：解析一段剧本，只调一次对话模型，只返回镜头草稿。 */
export function parseStoryboardSegment(projectId: string, body: {
  script_node_ids: readonly string[];
  segment_index: number;
  segment_count: number;
  alias: string;
  model_id: string;
  entities: Array<{ kind: string; name: string; description: string }>;
  style_prefix: string;
}) {
  return requestJson<StoryboardParseResult>(`${projectBase(projectId)}/parse`, '解析剧本', json(body));
}
