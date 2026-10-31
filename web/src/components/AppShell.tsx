import { lazy, Suspense, useEffect, useRef } from 'react';
import { LayoutGroup, motion } from 'motion/react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { HomeIcon, Moon, Palette, Settings, Sparkles, Sun } from 'lucide-react';

import { ChangelogButton } from '@/components/ChangelogButton';
import { TeamShareReminder, type TeamShareReminderHandle } from '@/components/team/TeamShareReminder';
import { useSSE } from '@/hooks/useSSE';
import { publishGatewayTask, publishGatewayConnected } from '@/api/gatewayEvents';
import { Home } from '@/pages/Home';
import { Studio } from '@/pages/Studio';
import { CanvasProjectIndex } from '@/pages/CanvasProjectIndex';
import { CanvasEditor } from '@/pages/CanvasEditor';
import { ConsoleLayout, rememberCreativeLocation } from '@/pages/settings/ConsoleLayout';
import { setTheme, useTheme, type Theme } from '@/lib/theme';
import { SwapIcon } from '@/components/ui/swap-icon';
import { AnnouncementHost } from '@/components/AnnouncementDialog';
import { UpdateButton, UpdateProvider } from '@/components/UpdateControl';
import { Button } from '@/components/ui/button';

// 组件样例页只在 dev 存在，生产构建整段摇掉
const Kit = import.meta.env.DEV ? lazy(() => import('@/pages/Kit').then(m => ({ default: m.Kit }))) : null;

/** 深浅主题切换：图标显示目的地（暗色显太阳 = 点了去浅色） */
function ThemeToggle() {
  const theme = useTheme();
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button variant="bare"
      type="button"
      aria-label={next === 'light' ? '切换到浅色主题' : '切换到深色主题'}
      onClick={() => setTheme(next)}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-glass backdrop-blur-glass text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <SwapIcon swapKey={theme}>{theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}</SwapIcon>
    </Button>
  );
}

const NAV_TABS: { to: string; label: string; icon: typeof HomeIcon }[] = [
  { to: '/', label: '主页', icon: HomeIcon },
  { to: '/studio', label: '创作台', icon: Sparkles },
  { to: '/canvas', label: '画布', icon: Palette },
];

function NavTab({ to, label, isActive, icon: Icon, badge = 0 }: { to: string; label: string; isActive: boolean; icon: typeof HomeIcon; badge?: number }) {
  return (
    <Link
      href={to}
      aria-current={isActive ? 'page' : undefined}
      aria-label={badge > 0 ? `${label}，${badge} 个待批准` : undefined}
      className={[
        // 透明壳 + isolate 自成层叠上下文：选中态玻璃药丸是底层 motion 元素，文字常驻其上
        'relative isolate h-9 md:h-10 inline-flex shrink-0 items-center gap-1.5 md:gap-2 rounded-full px-2 sm:px-3 md:px-5 text-xs md:text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      ].join(' ')}
    >
      {isActive && (
        // magic-move：共享 layoutId 的药丸在 tab 间切换时由 framer-motion 自动 FLIP 滑过去；
        // 玻璃质感 + 锥形金属环（.nav-active-ring）随药丸一起移动
        <motion.span
          layoutId="nav-active-pill"
          aria-hidden
          data-testid="nav-active-indicator"
          // 定位走 className：framer-motion 会吞掉 style 里的 position/inset（它自管 layout 元素的盒定位），
          // 但不碰 className；.nav-active-ring 已去掉 position，absolute 不再被覆盖，稳定铺满整颗 tab
          className="absolute inset-0 -z-10 rounded-full border border-input bg-glass nav-tab-glass nav-active-ring backdrop-blur-glass"
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        />
      )}
      <Icon size={18} aria-hidden />
      {label}
      {badge > 0 && <span aria-hidden className="ml-0.5 rounded-full bg-primary px-1.5 text-xs leading-4 text-primary-foreground">{badge}</span>}
    </Link>
  );
}

export function AppShell({ latestRelease = null, runtimeMode = 'source' }: { latestRelease?: string | null; runtimeMode?: 'source' | 'bundle' }) {
  return <UpdateProvider latestRelease={latestRelease} runtimeMode={runtimeMode}><AppShellContent /></UpdateProvider>;
}

function AppShellContent() {
  const [loc, setLocation] = useLocation();
  const onStudio = loc === '/studio';
  const onCanvas = loc.startsWith('/canvas');
  const onHome = loc === '/';
  useEffect(() => { rememberCreativeLocation(loc + window.location.search); }, [loc]);
  const onSettings = loc.startsWith('/settings');
  const immersiveCanvas = /^\/canvas\/[^/]+$/.test(loc);
  // 这些页面自带滚动容器；外层再留一条滚动槽会让内容右侧多出 10px 空白。
  const pageOwnsScroll = loc === '/studio' || loc === '/canvas';
  const activeIndex = onHome ? 0 : onStudio ? 1 : onCanvas ? 2 : -1;
  const reminderRef = useRef<TeamShareReminderHandle>(null);
  // 全壳唯一一条 SSE（服务端每会话限 4 条）：顺带把团队库变更交给分享提醒，重连时让它重取显示名。
  useSSE({
    onTeamLibraryChanged: event => reminderRef.current?.notify(event),
    onGatewayTask: publishGatewayTask,
    onConnect: () => { reminderRef.current?.refreshProfile(); publishGatewayConnected(); },
  });

  const ContentTag = onSettings ? 'div' : 'main';
  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {!immersiveCanvas && <header className="sticky top-0 z-30 shrink-0">
        <div className="mx-auto grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 lg:h-20 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-4 lg:px-8 lg:py-0">
          <Link href="/" className="flex shrink-0 items-baseline gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
            <span className="brand-wordmark font-display text-2xl">Atelier</span>
          </Link>
          <LayoutGroup>
            <nav className="order-last col-span-2 flex min-w-0 items-center justify-center gap-1 overflow-x-auto no-scrollbar px-2 lg:order-none lg:col-span-1 lg:gap-3 lg:px-3">
              {NAV_TABS.map((t, i) => (
                <NavTab key={t.to} to={t.to} label={t.label} isActive={activeIndex === i} icon={t.icon} />
              ))}
            </nav>
          </LayoutGroup>
          <div className="flex min-w-0 shrink-0 items-center justify-end gap-1 sm:gap-2">
            <UpdateButton />
            <ChangelogButton />
            <ThemeToggle />
            <Link
              href="/settings/providers"
              aria-label="设置"
              className={[
                'inline-flex h-10 w-10 items-center justify-center rounded-full bg-glass backdrop-blur-glass transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                onSettings ? 'text-foreground ring-1 ring-border' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              ].join(' ')}
            >
              <Settings size={18} aria-hidden />
            </Link>
          </div>
        </div>
        <UpdateButton mobile />
      </header>}

      {/* stable-scroll：本壳是首页/工坊的真·滚动容器，固定滚动槽避免滚动条增删改内宽 → 列宽 → w-full 图高 → 墙高的自激抽搐环（见 scrollbar-gutter-feedback-loop memory）*/}
      <ContentTag className={immersiveCanvas || pageOwnsScroll ? 'flex-1 min-h-0 overflow-hidden' : 'flex-1 min-h-0 overflow-y-auto stable-scroll'}>
        <Switch>
          <Route path="/">{() => <Home />}</Route>
          <Route path="/studio">{() => <Studio />}</Route>
          <Route path="/canvas/:projectId">{params => (
            <CanvasEditor
              key={params.projectId}
              projectId={decodeURIComponent(params.projectId)}
              onBack={() => setLocation('/canvas')}
              onSwitchProject={projectId => setLocation(`/canvas/${encodeURIComponent(projectId)}`)}
            />
          )}</Route>
          <Route path="/canvas">{() => (
            <CanvasProjectIndex
              onOpenProject={projectId => setLocation(`/canvas/${encodeURIComponent(projectId)}`)}
            />
          )}</Route>
          <Route path="/settings">{() => <Redirect to="/settings/providers" replace />}</Route>
          <Route path="/settings/providers/new">{() => <ConsoleLayout />}</Route>
          <Route path="/settings/:page">{() => <ConsoleLayout />}</Route>
          {Kit && <Route path="/kit">{() => <Suspense fallback={null}><Kit /></Suspense>}</Route>}
          <Route>
            <Redirect to="/" replace />
          </Route>
        </Switch>
      </ContentTag>
      <TeamShareReminder ref={reminderRef} />
      <AnnouncementHost />
    </div>
  );
}
