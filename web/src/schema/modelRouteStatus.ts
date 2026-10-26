export interface ModelRouteMemberStatusResponse {
  members: {
    modality: string; alias: string; reason?: string; since: string | null;
    next_probe_at: string; route_ids: string[];
  }[];
  unavailable_routes: { id: string; name: string; modality: string }[];
}
