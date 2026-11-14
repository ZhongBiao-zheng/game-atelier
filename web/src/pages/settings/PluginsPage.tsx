import { useEffect, useState } from 'react';

import { fetchPlugins, setPluginEnabled } from '@/api/plugins';
import { pluginIcon, PluginIcon } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Hint } from '@/components/ui/tooltip';
import { setPluginsSnapshot } from '@/plugin-host/registry';
import type { PluginEntry } from '@/schema/plugins';

function PluginRow({ plugin, busy, onToggle }: {
  plugin: PluginEntry; busy: boolean; onToggle: (enabled: boolean) => void;
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
    </div>
    <Switch checked={plugin.enabled} aria-label={`启用${name}`} disabled={!usable || busy} onCheckedChange={onToggle} />
  </li>;
}

export function PluginsPage() {
  const [plugins, setLocalPlugins] = useState<PluginEntry[] | null>(null);
  // 画布的添加菜单与插件节点读的是全局注册表，这里的变化要同步过去。
  const setPlugins = (next: PluginEntry[]) => { setLocalPlugins(next); setPluginsSnapshot(next); };
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchPlugins().then(listing => { if (active) setPlugins(listing.plugins); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  async function toggle(id: string, enabled: boolean) {
    setBusyId(id);
    setError(null);
    try {
      setPlugins((await setPluginEnabled(id, enabled)).plugins);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 以服务端为准：启用可能已被别处改过，或插件在这期间变得不可用。
      fetchPlugins().then(listing => setPlugins(listing.plugins)).catch(() => {});
    } finally {
      setBusyId(null);
    }
  }

  return <div className="min-w-0 space-y-5">
    {plugins && plugins.length === 0 && <div className="py-16 text-center">
      <p className="font-display text-display italic text-foreground/70">暂无插件</p>
    </div>}
    {plugins && plugins.length > 0 && <ul aria-label="插件" className="divide-y divide-border rounded-xl border border-border bg-card p-5">
      {plugins.map(plugin => <PluginRow key={plugin.id} plugin={plugin} busy={busyId !== null}
        onToggle={enabled => void toggle(plugin.id, enabled)} />)}
    </ul>}
    {!plugins && !error && <p role="status" className="text-xs text-muted-foreground">读取中…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
