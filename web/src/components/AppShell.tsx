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
        'h-9 md:h-10 inline-flex shrink-0 items-center gap-1.5 md:gap-2 rounded-full border px-3 md:px-5 text-xs md:text-sm font-medium backdrop-blur-2xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        isActive
          ? 'border-white/15 bg-[rgba(36,35,33,0.68)] text-foreground [box-shadow:inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(255,255,255,0.05),0_12px_28px_rgba(0,0,0,0.42),0_0_0_1px_rgba(255,255,255,0.04)]'
          : 'border-white/[0.06] bg-white/[0.03] text-muted-foreground [box-shadow:inset_0_1px_0_rgba(255,255,255,0.06)] hover:border-white/10 hover:bg-white/[0.06] hover:text-foreground',
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
        <div className="mx-auto grid h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 md:h-20 md:gap-4 md:px-8">
          <Link href="/" className="flex shrink-0 items-baseline gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
            <span
              className="text-2xl font-normal"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Atelier
            </span>
            <span className="text-xs text-muted-foreground">· 工作流</span>
          </Link>
          <nav className="flex min-w-0 max-w-[calc(100vw-9rem)] items-center justify-center gap-1 overflow-x-auto md:max-w-none md:gap-3">
            <NavTab to="/" label="主页" isActive={onHome} icon={HomeIcon} />
            <NavTab to="/studio" label="出图" isActive={onStudio} icon={Sparkles} />
            <NavTab to="/character" label="工坊" isActive={onCharacter} icon={UserRound} />
          </nav>
          <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
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
