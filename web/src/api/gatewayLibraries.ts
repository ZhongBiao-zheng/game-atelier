import { requestJson } from './http';
import type { TeamLibraryGatewayState } from '@/schema/gatewayShares';

export interface GatewayLibrary {
  id: string; name: string; owner_name: string; updated_at: string; counts: Record<string, number>;
}
export interface GatewayLibrarySource {
  gateway_alias: string; owner_name: string; unreachable: boolean; libraries: GatewayLibrary[];
}
export interface GatewayLibrarySelection extends GatewayLibrary { alias: string }
export interface GatewayLibraryEntry {
  entry_id: string; kind: 'raw' | 'media' | 'generation' | 'prompt'; title: string;
  author?: string | null; mime_type?: string | null; width?: number | null; height?: number | null;
  duration_s?: number | null; tags: string[]; category?: string | null;
  prompt_text?: string | null; preview_count: number; has_content?: boolean;
}
export interface GatewayShareState extends Partial<Pick<TeamLibraryGatewayState, 'publishes'>> { shared_library_ids: string[]; gateway_enabled: boolean; can_publish?: boolean }
export const getGatewayShareState = () => requestJson<GatewayShareState>('/api/team-library-gateway-share', '读取共享设置');
export const setGatewayShare = (id: string, enabled: boolean) => requestJson<GatewayShareState>(
  `/api/team-library-gateway-share/${encodeURIComponent(id)}`, '修改共享设置', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
export const listGatewayLibraries = () => requestJson<GatewayLibrarySource[]>('/api/gateway-libraries', '读取同事共享');
const base = (library: GatewayLibrarySelection) => `/api/gateway-libraries/${encodeURIComponent(library.alias)}/${encodeURIComponent(library.id)}/assets`;
export const listGatewayAssets = (library: GatewayLibrarySelection) => requestJson<GatewayLibraryEntry[]>(base(library), '读取同事共享');
export const gatewayThumbUrl = (library: GatewayLibrarySelection, entry: GatewayLibraryEntry, preview?: number) =>
  `${base(library)}/${encodeURIComponent(entry.entry_id)}${preview == null ? '' : `/previews/${preview}`}/thumb?w=1024`;

export const gatewayContentUrl = (library: GatewayLibrarySelection, entry: GatewayLibraryEntry) =>
  `${base(library)}/${encodeURIComponent(entry.entry_id)}/content`;
export interface ManagedGatewayShares { libraries: (GatewayLibrary & { size_bytes: number })[]; size_bytes: number }
export const getManagedGatewayShares = () => requestJson<ManagedGatewayShares>('/api/gateway-shares', '读取同事共享');
export const stopManagedGatewayShare = (id: string) => requestJson<ManagedGatewayShares>(`/api/gateway-shares/${encodeURIComponent(id)}`, '停止共享', { method: 'DELETE' });
