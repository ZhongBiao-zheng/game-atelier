import { useMemo } from 'react';
import { useSearch } from 'wouter';

export interface WorkshopReturnContext {
  folderId: string;
  view: 'overview' | 'art' | 'ui' | 'video';
}

const VIEWS = new Set<WorkshopReturnContext['view']>(['overview', 'art', 'ui', 'video']);

export function workshopReturnContext(search: string): WorkshopReturnContext | null {
  const params = new URLSearchParams(search);
  const folderId = params.get('fromFolder');
  const view = params.get('fromView');
  if (!folderId || !view || !VIEWS.has(view as WorkshopReturnContext['view'])) return null;
  return { folderId, view: view as WorkshopReturnContext['view'] };
}

export function withWorkshopReturn(path: string, context: WorkshopReturnContext | null): string {
  if (!context) return path;
  const params = new URLSearchParams({ fromFolder: context.folderId, fromView: context.view });
  return `${path}?${params.toString()}`;
}

export function useWorkshopReturn(): WorkshopReturnContext | null {
  const search = useSearch();
  return useMemo(() => workshopReturnContext(search), [search]);
}

export function workshopFolderPath(projectId: string, context: WorkshopReturnContext): string {
  return `/workshop/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(context.folderId)}/${context.view}`;
}
