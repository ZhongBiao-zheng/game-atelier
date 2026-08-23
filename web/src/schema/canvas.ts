import type { JobKind, JobParams } from './jobs';

export interface CanvasPoint { x: number; y: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasViewport { x: number; y: number; zoom: number }

interface CanvasNodeBase {
  id: string;
  position: CanvasPoint;
  size?: CanvasSize | null;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  data: { title?: string | null; text: string };
}

export interface CanvasResourceNode extends CanvasNodeBase {
  type: 'resource';
  data: {
    media_kind: 'image' | 'video' | 'audio';
    path: string;
    filename: string;
  };
}

export interface CanvasGenerationNode extends CanvasNodeBase {
  type: 'generation';
  data: {
    media_kind: JobKind;
    draft: { prompt: string; model: string; alias?: string | null; params: JobParams };
    job_ids: string[];
    active_job_id?: string | null;
    selected_output_index?: number | null;
  };
}

export type CanvasNode = CanvasTextNode | CanvasResourceNode | CanvasGenerationNode;

export interface ProvenanceConnection {
  id: string;
  kind: 'provenance';
  source_node_id: string;
  target_node_id: string;
}

export interface CanvasDocument {
  schema_version: 1;
  project_id: string;
  viewport: CanvasViewport;
  nodes: CanvasNode[];
  connections: ProvenanceConnection[];
  updated_at: string;
}

export interface CanvasProject {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CanvasProjectSummary extends CanvasProject {
  cover: { path: string; job_id?: string | null } | null;
}

export interface CanvasUpload {
  path: string;
  filename: string;
  media_kind: 'image' | 'video' | 'audio';
}
