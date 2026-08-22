import { Film, Images, LayoutDashboard, PanelsTopLeft } from 'lucide-react';

export type WorkshopWorkspace = 'overview' | 'art' | 'ui' | 'video';

export const WORKSPACE_DESCRIPTORS = [
  {
    id: 'overview',
    label: '概览',
    sidebarLabel: '项目首页',
    icon: LayoutDashboard,
  },
  {
    id: 'art',
    label: '美术',
    sidebarLabel: '角色',
    icon: Images,
  },
  {
    id: 'ui',
    label: 'UI',
    sidebarLabel: 'UI',
    icon: PanelsTopLeft,
  },
  {
    id: 'video',
    label: '视频',
    sidebarLabel: '视频',
    icon: Film,
  },
] satisfies Array<{
  id: WorkshopWorkspace;
  label: string;
  sidebarLabel: string;
  icon: typeof LayoutDashboard;
}>;

export function isWorkshopWorkspace(value?: string): value is WorkshopWorkspace {
  return WORKSPACE_DESCRIPTORS.some(workspace => workspace.id === value);
}

export function getWorkspaceDescriptor(workspace: WorkshopWorkspace) {
  return WORKSPACE_DESCRIPTORS.find(candidate => candidate.id === workspace)!;
}
