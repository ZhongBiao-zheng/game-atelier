import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { HomeIcon, Settings, Sparkles, UserRound } from 'lucide-react';

import { Home } from '@/pages/Home';
import { Studio } from '@/pages/Studio';
import { CharacterDetail } from '@/pages/CharacterDetail';
import { SettingsPage } from '@/pages/settings/Settings';

function NavTab({ to, label, isActive, icon: Icon }: { to: string; label: string; isActive: boolean; icon: typeof HomeIcon }) {
  return (
    <Link
      href={to}
      className={[
        'h-9 md:h-10 inline-flex shrink-0 items-center gap-1.5 md:gap-2 rounded-full px-3 md:px-5 text-xs md:text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary backdrop-blur-xl',
        isActive
          ? 'bg-card/70 text-foreground ring-1 ring-white/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-card/30',
      ].join(' ')}
    >
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30">
        <div className="mx-auto flex h-14 md:h-20 min-w-0 items-center gap-2 px-3 md:gap-4 md:px-8">
          <Link href="/" className="flex shrink-0 items-baseline gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
            <span
              className="text-2xl font-normal"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Atelier
            </span>
            <span className="text-xs text-muted-foreground">· 工作流</span>
          </Link>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:gap-3">
            <NavTab to="/" label="主页" isActive={onHome} icon={HomeIcon} />
            <NavTab to="/studio" label="出图" isActive={onStudio} icon={Sparkles} />
            <NavTab to="/character" label="工坊" isActive={onCharacter} icon={UserRound} />
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/settings"
              aria-label="设置"
              className={[
                'inline-flex h-10 w-10 items-center justify-center rounded-full bg-card/35 backdrop-blur-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                onSettings ? 'text-primary ring-1 ring-border/80' : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
              ].join(' ')}
            >
              <Settings size={18} aria-hidden />
            </Link>
          </div>
        </div>
      </header>

      <main role="main">
        <Switch>
          <Route path="/">{() => <Home />}</Route>
          <Route path="/studio">{() => <Studio />}</Route>
          <Route path="/character">{() => <CharacterDetail />}</Route>
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
