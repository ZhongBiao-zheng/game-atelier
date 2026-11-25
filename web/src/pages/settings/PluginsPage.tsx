import { useEffect, useState, type ComponentType } from 'react';

import { fetchPlugins, setPluginEnabled } from '@/api/plugins';
import { pluginIcon, PluginIcon } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Hint } from '@/components/ui/tooltip';
import { useHostPlugins } from '@/plugin-host/hostPlugins';
import { getPluginsSnapshot, setPluginsSnapshot } from '@/plugin-host/registry';
import type { PluginEntry } from '@/schema/plugins';
import { errorText } from '@/lib/errorText';

/** 只换掉这一个插件的条目，别的插件保持原样：并发的启停各自只认自己那一行的结果。 */
function mergeEntry(list: readonly PluginEntry[], entry: PluginEntry): PluginEntry[] {
  return list.some(plugin => plugin.id === entry.id)
    ? list.map(plugin => plugin.id === entry.id ? entry : plugin)
    : [...list, entry];
}

function PluginRow({ plugin, busy, onToggle, Settings }: {
  plugin: PluginEntry; busy: boolean; onToggle: (enabled: boolean) => void; Settings?: ComponentType;
}) {
  const manifest = plugin.manifest;
  const Icon = manifest ? pluginIcon(manifest.icon) : PluginIcon;
  const name = manifest?.name ?? plugin.id;
  const usable = plugin.availability === 'ok';
  return <li className="flex items-center gap-4 py-4 first:pt-0 last:pb-0">
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Icon /></span>
    <div className="min-w-0 flex-1 space-y-1">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        <span className="truncate">{name}</span>
        {manifest && <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{manifest.version}</span>}
      </h2>
      {plugin.availability === 'invalid'
        ? <Hint label={plugin.reason ?? undefined}><p className="w-fit text-xs text-destructive">无法读取</p></Hint>
        : !usable
          ? <p className="text-xs text-destructive">{plugin.reason}</p>
          : <p className="truncate text-xs text-muted-foreground">{manifest?.description}</p>}
      {plugin.enabled && usable && Settings && <Settings />}
    </div>
    <Switch checked={plugin.enabled} aria-label={`启用${name}`} disabled={!usable || busy} onCheckedChange={onToggle} />
  </li>;
}

export function PluginsPage() {
  const [plugins, setLocalPlugins] = useState<PluginEntry[] | null>(null);
  // 画布的添加菜单与插件节点读的是全局注册表，这里的变化要同步过去。
  const setPlugins = (next: PluginEntry[]) => { setLocalPlugins(next); setPluginsSnapshot(next); };
  // 在途的插件 ID：每行各管各的，两个开关可以同时在请求。
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  // 已启用的宿主插件（ADR-0039 / ADR-0041）在这里加载分块，渲染它们的设置区；关闭的不加载。
  const hostPlugins = useHostPlugins();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchPlugins().then(listing => { if (active) setPlugins(listing.plugins); })
      .catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, []);

  // 乐观切换：开关立刻到位，只有这一行在请求期间禁用；失败以服务端为准拉回。
  // 响应是整份清单，但只合入这一个插件的条目（本地列表和画布读的注册表都是），
  // 不然后发先至的响应会把另一行在途或已确认的状态盖回旧值。
  async function toggle(id: string, enabled: boolean) {
    setBusyIds(current => new Set(current).add(id));
    setError(null);
    setLocalPlugins(current => current?.map(plugin => plugin.id === id ? { ...plugin, enabled } : plugin) ?? current);
    const confirm = (entry: PluginEntry) => {
      setLocalPlugins(current => current ? mergeEntry(current, entry) : current);
      setPluginsSnapshot(mergeEntry(getPluginsSnapshot(), entry));
    };
    try {
      const entry = (await setPluginEnabled(id, enabled)).plugins.find(plugin => plugin.id === id);
      if (entry) confirm(entry);
    } catch (e) {
      setError(errorText(e));
      // 以服务端为准：启用可能已被别处改过，或插件在这期间变得不可用。读不回来就退回点击前。
      try {
        const entry = (await fetchPlugins()).plugins.find(plugin => plugin.id === id);
        if (entry) confirm(entry);
      } catch {
        setLocalPlugins(current => current?.map(plugin => plugin.id === id ? { ...plugin, enabled: !enabled } : plugin) ?? current);
      }
    } finally {
      setBusyIds(current => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  return <div className="min-w-0 space-y-5">
    {plugins && plugins.length === 0 && <div className="py-16 text-center">
      <p className="font-display text-display italic text-foreground/70">暂无插件</p>
    </div>}
    {plugins && plugins.length > 0 && <ul aria-label="插件" className="divide-y divide-border rounded-xl border border-border bg-card p-5">
      {plugins.map(plugin => <PluginRow key={plugin.id} plugin={plugin} busy={busyIds.has(plugin.id)}
        Settings={hostPlugins.get(plugin.id)?.Settings} onToggle={enabled => void toggle(plugin.id, enabled)} />)}
    </ul>}
    {!plugins && !error && <p role="status" className="text-xs text-muted-foreground">加载中…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
