import { useEffect, useState, type ComponentType } from 'react';
import { Link, Redirect, useLocation } from 'wouter';
import { ArrowLeft, HelpCircle, KeyRound, Split, Server, BarChart3, LibraryBig, Bot, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { listKeys, type KeyView } from '@/api/keys';
import { fetchGatewayProviderMe } from '@/api/gateway';
import { subscribeGatewayEvents } from '@/api/gatewayEvents';
import { ProvidersPage } from './ProvidersPage';
import { RoutesPage } from './RoutesPage';
import { GatewayPage } from './GatewayPage';
import { GATEWAY_HINT } from './LanSharingSection';
import { SYNC_HINT } from './TeamLibrariesSection';
import { UsagePage } from './usage/UsagePage';
import { LibrariesPage } from './LibrariesPage';
import { AgentPage } from './AgentPage';
import { PreferencesPage } from './PreferencesPage';

export const CONSOLE_NAV: {
  group: string;
  items: { path: string; label: string; page: ComponentType; icon: LucideIcon; hint?: string }[];
}[] = [
  { group: '模型', items: [
    { path: '/settings/providers', label: '供应商', page: ProvidersPage, icon: KeyRound },
    { path: '/settings/routes', label: '路由', page: RoutesPage, icon: Split },
    { path: '/settings/gateway', label: '网关', page: GatewayPage, icon: Server, hint: GATEWAY_HINT },
  ] },
  { group: '观测', items: [{ path: '/settings/usage', label: '用量', page: UsagePage, icon: BarChart3 }] },
  { group: '资源', items: [{ path: '/settings/libraries', label: '团队库', page: LibrariesPage, icon: LibraryBig, hint: SYNC_HINT }] },
  { group: '扩展', items: [{ path: '/settings/agent', label: 'Agent 连接', page: AgentPage, icon: Bot }] },
  { group: '', items: [{ path: '/settings/preferences', label: '设置', page: PreferencesPage, icon: SlidersHorizontal }] },
];
let lastCreativeLocation = '/';
export function rememberCreativeLocation(path: string) {
  if (!path.split('?')[0].startsWith('/settings')) lastCreativeLocation = path;
}

function GatewayConnection() {
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [keys, setKeys] = useState<KeyView[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void listKeys().then(data => {
        const gateways = data.keys.filter(key => key.provider === 'atelier');
        if (active) setKeys(gateways);
        void Promise.all(gateways.map(async key => (await fetchGatewayProviderMe(key.alias)) ? key.alias : null))
          .then(aliases => { if (active) setConnected(new Set(aliases.filter((alias): alias is string => alias !== null))); });
      }).catch(() => {});
    };
    refresh();
    const unsubscribe = subscribeGatewayEvents({ onTask: () => {}, onConnect: refresh });
    return () => { active = false; unsubscribe(); };
  }, []);
  return <div className="hidden space-y-2 px-3 text-xs text-muted-foreground md:block">
    {keys.map(key => <div key={key.alias} className="flex min-w-0 items-center gap-2" title={key.base_url ?? ''}>
      <span aria-label={connected.has(key.alias) ? '已连接' : '未连接'}
        className={`size-1.5 shrink-0 rounded-full ${connected.has(key.alias)
          ? 'bg-[color:var(--status-done)]' : 'bg-[color:var(--status-pending)]'}`} />
      <span className="truncate font-mono">{key.base_url}</span>
    </div>)}
  </div>;
}

export function ConsoleLayout() {
  const [location] = useLocation();
  const current = CONSOLE_NAV.flatMap(group => group.items).find(item => location === item.path);
  if (!current) return <Redirect to="/settings/providers" replace />;
  const Page = current.page;
  const groupLabel = CONSOLE_NAV.find(group => group.items.includes(current))?.group;
  return <div className="flex min-h-full min-w-0 flex-col bg-sidebar md:flex-row">
    <aside className="flex min-w-0 shrink-0 flex-col gap-6 border-b border-border p-4 md:sticky md:top-0 md:h-[calc(100dvh-80px)] md:w-[220px] md:border-b-0">
      <Link href={lastCreativeLocation} className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" aria-hidden />返回创作
      </Link>
      <nav aria-label="控制台" className="flex gap-2 overflow-x-auto md:flex-1 md:flex-col md:gap-[18px]">
        {CONSOLE_NAV.map(group => <div key={group.group} className={group.group ? 'shrink-0' : 'md:mt-auto'}>
          {!group.group && <GatewayConnection />}
          {group.group && <p className="mb-2 hidden px-3 text-xs text-subtle-foreground md:block">{group.group}</p>}
          <div className="flex gap-1 md:flex-col">
            {group.items.map(item => <Link key={item.path} href={item.path}
              aria-current={current.path === item.path ? 'page' : undefined}
              className={`flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm ${
                current.path === item.path ? 'bg-popover font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}>
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-sm ${current.path === item.path ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                <item.icon className="size-3.5" aria-hidden />
              </span>{item.label}
            </Link>)}
          </div>
        </div>)}
      </nav>
    </aside>
    <main className="console-panel m-2 min-w-0 flex-1 space-y-6 rounded-2xl border border-border bg-panel p-4 md:p-6">
      <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        {groupLabel && <span className="text-subtle-foreground">{groupLabel} /</span>}
        <h1 className="text-sm font-semibold">{current.label}</h1>
        {current.hint && <button type="button" title={current.hint} aria-label={current.hint}
          className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <HelpCircle className="size-3.5" aria-hidden />
        </button>}
      </div>
      <Page />
    </main>
  </div>;
}
