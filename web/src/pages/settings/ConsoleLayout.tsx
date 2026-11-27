import { useEffect, useState, type ComponentType } from 'react';
import { Link, Redirect, useLocation } from 'wouter';
import { AgentIcon, BackIcon, DeleteIcon, HelpIcon, KeyIcon, LibraryIcon, ParamsIcon, PluginIcon, RouteIcon, ServerIcon, ShareIcon, UsageIcon, type AppIcon } from '@/components/ui/icons';
import { listKeys, type KeyView } from '@/api/keys';
import { fetchGateway, fetchGatewayProviderMe, type GatewayState } from '@/api/gateway';
import { subscribeGatewayEvents } from '@/api/gatewayEvents';
import { RelayAdminPage, useAdminGateways } from './RelayAdminPage';
import { ProvidersPage } from './ProvidersPage';
import { RoutesPage } from './RoutesPage';
import { GatewayPage } from './GatewayPage';
import { GATEWAY_HINT } from './LanSharingSection';
import { SYNC_HINT } from './TeamLibrariesSection';
import { UsagePage } from './usage/UsagePage';
import { LibrariesPage } from './LibrariesPage';
import { AgentPage } from './AgentPage';
import { PluginsPage } from './PluginsPage';
import { PreferencesPage } from './PreferencesPage';
import { TrashPage } from './TrashPage';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { SelectionHighlight } from '@/components/ui/selection-highlight';

export const CONSOLE_NAV: {
  group: string;
  items: { path: string; label: string; page: ComponentType; icon: AppIcon; hint?: string }[];
}[] = [
  { group: '模型', items: [
    { path: '/settings/providers', label: '供应商', page: ProvidersPage, icon: KeyIcon },
    { path: '/settings/relay-admin', label: '团队网关管理', page: RelayAdminPage, icon: ServerIcon },
    { path: '/settings/routes', label: '智能路由', page: RoutesPage, icon: RouteIcon },
    { path: '/settings/gateway', label: '团队网关', page: GatewayPage, icon: ShareIcon, hint: GATEWAY_HINT },
  ] },
  { group: '观测', items: [{ path: '/settings/usage', label: '用量', page: UsagePage, icon: UsageIcon }] },
  { group: '资源', items: [
    { path: '/settings/libraries', label: '团队库', page: LibrariesPage, icon: LibraryIcon, hint: SYNC_HINT },
    { path: '/settings/trash', label: '回收站', page: TrashPage, icon: DeleteIcon },
  ] },
  { group: '扩展', items: [
    { path: '/settings/agent', label: 'Agent 连接', page: AgentPage, icon: AgentIcon },
    { path: '/settings/plugins', label: '插件', page: PluginsPage, icon: PluginIcon },
  ] },
  // 顶栏齿轮叫「设置」，这里叫「通用」并换图标，避免进来后看到两个同名同图标的入口。
  { group: '', items: [{ path: '/settings/preferences', label: '通用', page: PreferencesPage, icon: ParamsIcon }] },
];
let lastCreativeLocation = '/';
export function rememberCreativeLocation(path: string) {
  if (!path.split('?')[0].startsWith('/settings')) lastCreativeLocation = path;
}

function LocalGatewayStatus() {
  const [state, setState] = useState<GatewayState | null>(null);
  useEffect(() => {
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      void fetchGateway().then(next => {
        if (request === sequence) setState(next);
      }).catch(() => { if (request === sequence) setState(null); });
    };
    refresh();
    const unsubscribe = subscribeGatewayEvents({ onTask: () => {}, onConnect: refresh });
    return () => { sequence++; unsubscribe(); };
  }, []);
  if (!state?.enabled && !state?.config_error) return null;
  return <Hint label={state.config_error ?? state.status.error}><Link href="/settings/gateway"
    className="content-swap-in mb-1 flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${state.status.running
      ? 'bg-status-done' : state.status.error ? 'bg-destructive' : 'bg-status-pending'}`} />
    <span>团队网关 · {state.config_error ? '配置损坏' : state.status.running ? '运行中' : state.status.error ? '启动失败' : '未运行'}</span>
  </Link></Hint>;
}

const PREFERENCE_SECTIONS = [['appearance', '外观'], ['storage', '存储'], ['profile', '个人'], ['updates', '更新']] as const;
function PreferenceLinks() {
  const [hash, setHash] = useState(() => window.location.hash);
  // 「版本更新」只在安装包版本出现：页面里有这一节才给锚点。
  const [sections, setSections] = useState<readonly (typeof PREFERENCE_SECTIONS)[number][]>(
    () => PREFERENCE_SECTIONS.filter(([id]) => id !== 'updates'));
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    if (document.getElementById('updates')) setSections(PREFERENCE_SECTIONS);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const selected = sections.some(([id]) => hash === `#${id}`) ? hash : '#appearance';
  return <div aria-label="通用分组" className="flex shrink-0 gap-1 md:ml-5 md:flex-col md:border-l md:border-border md:pl-3">
    {sections.map(([id, label]) => <a key={id} href={`#${id}`}
      aria-current={selected === `#${id}` ? 'location' : undefined}
      onClick={() => setHash(`#${id}`)}
      className={`rounded-md px-3 py-2 text-xs whitespace-nowrap ${selected === `#${id}`
        ? 'bg-popover text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}>
      {label}
    </a>)}
  </div>;
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
    {keys.map(key => <Hint key={key.alias} label={key.base_url ?? ''}><div className="content-swap-in flex min-w-0 items-center gap-2">
      <span aria-label={connected.has(key.alias) ? '已连接' : '未连接'}
        className={`size-1.5 shrink-0 rounded-full ${connected.has(key.alias)
          ? 'bg-[color:var(--status-done)]' : 'bg-[color:var(--status-pending)]'}`} />
      <span className="truncate font-mono">{key.base_url}</span>
    </div></Hint>)}
  </div>;
}

export function ConsoleLayout() {
  const { aliases: adminAliases } = useAdminGateways();
  const [location] = useLocation();
  const current = CONSOLE_NAV.flatMap(group => group.items).find(item => location === item.path);
  if (!current) return <Redirect to="/settings/providers" replace />;
  const Page = current.page;
  const groupLabel = CONSOLE_NAV.find(group => group.items.includes(current))?.group;
  return <div className="flex min-h-full min-w-0 flex-col bg-sidebar md:flex-row">
    <aside className="flex min-w-0 shrink-0 flex-col gap-6 border-b border-border p-4 md:sticky md:top-0 md:h-[calc(100dvh-80px)] md:w-[220px] md:border-b-0">
      <Link href={lastCreativeLocation} className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
        <BackIcon aria-hidden />返回创作
      </Link>
      {/* 选中底色是一个跟着当前项滑动的独立层（SelectionHighlight 认 aria-current="page"），各项只换文字与图标颜色。 */}
      <nav aria-label="控制台" className="relative isolate flex gap-2 overflow-x-auto md:flex-1 md:flex-col md:gap-4.5">
        <SelectionHighlight className="bg-popover ring-0" />
        {CONSOLE_NAV.map(group => <div key={group.group} className={group.group ? 'shrink-0' : 'flex shrink-0 gap-1 md:mt-auto md:block'}>
          {!group.group && <><GatewayConnection /><LocalGatewayStatus /></>}
          {group.group && <p className="mb-2 hidden px-3 text-xs text-subtle-foreground md:block">{group.group}</p>}
          <div className="flex gap-1 md:flex-col">
            {group.items.map(item => {
              const link = <Link key={item.path} href={item.path}
                aria-current={current.path === item.path ? 'page' : undefined}
                className={`flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors ${
                  current.path === item.path ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}>
                <span className={`flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors ${current.path === item.path ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  <item.icon size="sm" aria-hidden />
                </span>{item.label}
              </Link>;
              // 团队网关管理要等身份查回来才知道显不显示：展开着长出来，不把下面的项一下顶开。
              return item.path === '/settings/relay-admin'
                ? <Collapse key={item.path} open={adminAliases.length > 0} appear className="shrink-0">{link}</Collapse>
                : link;
            })}
            {!group.group && current.path === '/settings/preferences' && <PreferenceLinks />}
          </div>
        </div>)}
      </nav>
    </aside>
    <main className="console-panel m-2 min-w-0 flex-1 rounded-2xl border border-border bg-panel p-4 md:p-6">
      {/* 换页时正文 150ms 淡入；侧栏的选中滑块交代方向，正文不位移。 */}
      <div key={current.path} className="content-swap-in space-y-6">
      {!['/settings/providers', '/settings/routes'].includes(current.path) && <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        {groupLabel && <span className="text-subtle-foreground">{groupLabel} /</span>}
        <h1 className="text-sm font-semibold">{current.label}</h1>
        {current.hint && <Hint label={current.hint}><Button variant="bare" type="button" aria-label={current.hint}
          className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <HelpIcon size="sm" aria-hidden />
        </Button></Hint>}
      </div>}
      <Page />
      </div>
    </main>
  </div>;
}
