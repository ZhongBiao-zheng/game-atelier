import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MediaAssetGrid } from './CreationAssetCards';
import type { CreationAsset } from '@/schema/creationAssets';

type Project = { projectId: string; name: string };
export function groupMediaAssets(assets: CreationAsset[], projects: Project[], currentProjectId?: string) {
  const names = new Map(projects.map(project => [project.projectId, project.name]));
  const groups = new Map<string, { id: string; name: string; assets: CreationAsset[]; newest: string }>();
  for (const asset of assets) {
    const ids = [...new Set(asset.project_ids.filter(id => names.has(id)))];
    for (const id of ids.length ? ids : ['unassigned']) {
      const group = groups.get(id) ?? { id, name: names.get(id) ?? '未归属', assets: [], newest: '' };
      group.assets.push(asset);
      if (asset.updated_at > group.newest) group.newest = asset.updated_at;
      groups.set(id, group);
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === 'unassigned' || b.id === 'unassigned') return a.id === b.id ? 0 : a.id === 'unassigned' ? 1 : -1;
    if (a.id === currentProjectId || b.id === currentProjectId) return a.id === b.id ? 0 : a.id === currentProjectId ? -1 : 1;
    return b.newest.localeCompare(a.newest) || a.name.localeCompare(b.name);
  });
}

function MediaGroup({ group, staleness, onOpen }: {
  group: ReturnType<typeof groupMediaAssets>[number];
  staleness: React.ComponentProps<typeof MediaAssetGrid>['staleness']; onOpen: (asset: CreationAsset) => void;
}) {
  const key = `atelier:media-group:${group.id}:collapsed`;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } });
  return <section aria-label={group.name} className="space-y-2">
    <Button variant="ghost" className="w-full justify-start px-0" aria-expanded={!collapsed} onClick={() => {
      setCollapsed(!collapsed); try { localStorage.setItem(key, String(!collapsed)); } catch { /* 存储不可用时本次仍可折叠。 */ }
    }}>
      {collapsed ? <ChevronRight /> : <ChevronDown />}<span className="truncate">{group.name}</span><span className="text-xs tabular-nums text-muted-foreground">{group.assets.length}</span>
    </Button>
    {!collapsed && <MediaAssetGrid assets={group.assets} staleness={staleness} onOpen={onOpen} />}
  </section>;
}

export function MediaAssetGroups({ assets, projects, currentProjectId, staleness, onOpen }: {
  assets: CreationAsset[]; projects: Project[]; currentProjectId?: string;
  staleness: React.ComponentProps<typeof MediaAssetGrid>['staleness']; onOpen: (asset: CreationAsset) => void;
}) {
  return <div className="space-y-3">{groupMediaAssets(assets, projects, currentProjectId).map(group =>
    <MediaGroup key={group.id} group={group} staleness={staleness} onOpen={onOpen} />)}</div>;
}
