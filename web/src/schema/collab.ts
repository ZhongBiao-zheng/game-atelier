import type { CanvasDocument } from './canvas';

export const COLLAB_PROTOCOL_VERSION = 1;
export type CollabMode = 'edit' | 'view';

export interface CollabCard {
  peer_key: string;
  project_id: string;
  name: string;
  display_name: string;
  is_self: boolean;
  authenticated?: boolean;
  mode: CollabMode;
  requires_passcode: boolean;
  allow_borrow_provider: boolean;
  online_count: number;
  node_count: number;
  cover_version_id: string | null;
  updated_at: string;
  protocol_version: number;
}

export interface CollabSettings {
  mode: CollabMode;
  allow_borrow_provider: boolean;
  passcode?: string;
}

export interface CollabDocument {
  document: CanvasDocument;
  mode: CollabMode;
  name: string;
  allow_borrow_provider: boolean;
  owner_display_name: string;
  protocol_version: number;
}
