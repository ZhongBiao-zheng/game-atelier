import { useEffect, useState } from 'react';
import { Link, Redirect, useLocation } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import { listKeys, type KeyView } from '@/api/keys';
import { fetchGatewayProviderMe } from '@/api/gateway';
import { subscribeGatewayEvents } from '@/api/gatewayEvents';
import { ProvidersPage } from './ProvidersPage';
import { RoutesPage } from './RoutesPage';
import { GatewayPage } from './GatewayPage';
import { UsagePage } from './UsagePage';
import { LibrariesPage } from './LibrariesPage';
import { AgentPage } from './AgentPage';
import { PreferencesPage } from './PreferencesPage';

export const CONSOLE_NAV = [
  { group: '模型', items: [
    { path: '/settings/providers', label: '供应商', page: ProvidersPage },
    { path: '/settings/routes', label: '路由', page: RoutesPage },
    { path: '/settings/gateway', label: '网关', page: GatewayPage },
  ] },
  { group: '观测', items: [{ path: '/settings/usage', label: '用量', page: UsagePage }] },
  { group: '资源', items: [{ path: '/settings/libraries', label: '团队库', page: LibrariesPage }] },
  { group: '扩展', items: [{ path: '/settings/agent', label: 'Agent 连接', page: AgentPage }] },
  { group: '', items: [{ path: '/settings/preferences', label: '设置', page: PreferencesPage }] },
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
  return <div className="flex min-h-full min-w-0 flex-col md:flex-row">
    <aside className="flex shrink-0 flex-col gap-6 border-b border-border p-4 md:w-[220px] md:border-b-0 md:border-r">
      <Link href={lastCreativeLocation} className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" aria-hidden />返回创作
      </Link>
      <nav aria-label="控制台" className="flex gap-2 overflow-x-auto md:flex-1 md:flex-col md:gap-6">
        {CONSOLE_NAV.map(group => <div key={group.group} className={group.group ? 'shrink-0' : 'md:mt-auto'}>
          {group.group && <p className="mb-2 hidden px-3 text-xs text-muted-foreground md:block">{group.group}</p>}
          <div className="flex gap-1 md:flex-col">
            {group.items.map(item => <Link key={item.path} href={item.path}
              aria-current={current.path === item.path ? 'page' : undefined}
              className={`flex h-[34px] shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm ${
                current.path === item.path ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}>
              {item.label}
            </Link>)}
          </div>
        </div>)}
      </nav>
      <GatewayConnection />
    </aside>
    <main className="min-w-0 flex-1 space-y-6 p-4 md:p-8">
      <h1 className="text-base font-medium">{current.label}</h1>
      <Page />
    </main>
  </div>;
}
