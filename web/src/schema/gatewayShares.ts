/** ADR-0035：公开传输模型不包含本机路径、生成参数或参考素材。 */
export interface SharedBlob { sha256: string; size: number }
export interface SharedFile extends SharedBlob { filename: string }
export interface SharedManifestEntry {
  entry_id: string; kind: 'raw' | 'media' | 'generation' | 'prompt'; title: string;
  author?: string | null; mime_type?: string | null; width?: number | null; height?: number | null;
  duration_s?: number | null; tags: string[]; category?: string | null; prompt_text?: string | null;
  file?: SharedFile | null; previews: SharedBlob[];
}
export interface SharedLibraryManifest {
  share_id: string; name: string; owner_name: string; updated_at: string; entries: SharedManifestEntry[];
}
export interface GatewayPublishTarget {
  synced_at?: string | null; error?: string | null;
  status: 'pending' | 'syncing' | 'synced' | 'failed' | 'stopped';
  uploaded: number; total: number; delete_pending: boolean;
}
export interface TeamLibraryGatewayState {
  shared_library_ids: string[];
  publishes: Record<string, { share_id: string; gateways: Record<string, GatewayPublishTarget> }>;
}
export interface GatewayKeyCreate {
  name: string; token?: string; role: 'member' | 'admin';
  limits: { period: 'day' | 'week' | 'month'; cap_cny: number }[];
  allowed_models: string[] | null; allowed_aliases: string[] | null;
}
