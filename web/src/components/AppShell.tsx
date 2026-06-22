import { useState } from 'react';
import { LayoutGroup, motion } from 'motion/react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { HomeIcon, Moon, Settings, Sparkles, Sun, UserRound } from 'lucide-react';

import { Home } from '@/pages/Home';
import { Studio } from '@/pages/Studio';
import { CharacterDetail } from '@/pages/CharacterDetail';
import { SettingsPage } from '@/pages/settings/Settings';
import { applyTheme, loadTheme, saveTheme, type Theme } from '@/lib/theme';

/** 深浅主题切换：图标显示目的地（暗色显太阳 = 点了去浅色） */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={next === 'light' ? '切换到浅色主题' : '切换到深色主题'}
      onClick={() => {
        setTheme(next);
        applyTheme(next);
        saveTheme(next);
      }}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-glass backdrop-blur-glass text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {theme === 'dark' ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}

const NAV_TABS: { to: string; label: string; icon: typeof HomeIcon }[] = [
  { to: '/', label: '主页', icon: HomeIcon },
  { to: '/studio', label: '出图', icon: Sparkles },
  { to: '/character', label: '工坊', icon: UserRound },
];

function NavTab({ to, label, isActive, icon: Icon }: { to: string; label: string; isActive: boolean; icon: typeof HomeIcon }) {
  return (
    <Link
      href={to}
      aria-current={isActive ? 'page' : undefined}
      className={[
        // 透明壳 + isolate 自成层叠上下文：选中态玻璃药丸是底层 motion 元素，文字常驻其上
        'relative isolate h-9 md:h-10 inline-flex shrink-0 items-center gap-1.5 md:gap-2 rounded-full px-3 md:px-5 text-xs md:text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
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
    </Link>
  );
}

export function AppShell() {
  const [loc] = useLocation();
  const onCharacter = loc.startsWith('/character');
  const onStudio = loc === '/studio';
  const onHome = loc === '/';
  const onSettings = loc.startsWith('/settings');
  const activeIndex = onHome ? 0 : onStudio ? 1 : onCharacter ? 2 : -1;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 shrink-0">
        <div className="mx-auto grid h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 md:h-20 md:gap-4 md:px-8">
          <Link href="/" className="flex shrink-0 items-baseline gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
            <span className="font-display text-2xl font-normal">
              Atelier
            </span>
            <span className="hidden text-xs text-muted-foreground sm:inline">· 工作流</span>
          </Link>
          <LayoutGroup>
            <nav className="flex min-w-0 max-w-[calc(100vw-9rem)] items-center justify-center gap-1 overflow-x-auto no-scrollbar px-2 md:max-w-none md:gap-3 md:px-3">
              {NAV_TABS.map((t, i) => (
                <NavTab key={t.to} to={t.to} label={t.label} isActive={activeIndex === i} icon={t.icon} />
              ))}
            </nav>
          </LayoutGroup>
          <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
            <ThemeToggle />
            <Link
              href="/settings"
              aria-label="设置"
              className={[
                'inline-flex h-10 w-10 items-center justify-center rounded-full bg-glass backdrop-blur-glass transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                onSettings ? 'text-primary ring-1 ring-border' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              ].join(' ')}
            >
              <Settings size={18} aria-hidden />
            </Link>
          </div>
        </div>
      </header>

      <main role="main" className="flex-1 min-h-0 overflow-y-auto">
        <Switch>
          <Route path="/">{() => <Home />}</Route>
          <Route path="/studio">{() => <Studio />}</Route>
          <Route path="/character">{() => <CharacterDetail />}</Route>
          <Route path="/character/:id/:assetSlot/:jobId/:imagePath">
            {(params) => (
              <CharacterDetail
                characterId={params.id}
                assetSlot={params.assetSlot}
                jobId={params.jobId}
                imagePath={params.imagePath}
              />
            )}
          </Route>
          <Route path="/character/:id/:assetSlot">
            {(params) => <CharacterDetail characterId={params.id} assetSlot={params.assetSlot} />}
          </Route>
          <Route path="/character/:id">
            {(params) => <CharacterDetail characterId={params.id} />}
          </Route>
          <Route path="/settings">{() => <SettingsPage />}</Route>
          <Route path="/settings/keys">{() => <SettingsPage />}</Route>
          <Route>
            <Redirect to="/" replace />
          </Route>
        </Switch>
      </main>
    </div>
  );
}
