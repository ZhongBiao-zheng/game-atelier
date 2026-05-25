import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { Settings } from 'lucide-react';

import { Home } from '@/pages/Home';
import { Studio } from '@/pages/Studio';
import { CharacterDetail } from '@/pages/CharacterDetail';
import { KeysPage } from '@/pages/settings/Keys';

function NavTab({ to, label, isActive }: { to: string; label: string; isActive: boolean }) {
  return (
    <Link
      href={to}
      className={[
        'h-14 inline-flex items-center px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm',
        isActive
          ? 'text-foreground border-b-2 border-primary -mb-px font-medium'
          : 'text-muted-foreground hover:text-foreground',
      ].join(' ')}
    >
      {label}
    </Link>
  );
}

export function AppShell() {
  const [loc] = useLocation();
  const onCharacter = loc.startsWith('/character');
  const onStudio = loc === '/studio';
  const onKeys = loc === '/settings/keys';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 bg-card border-b border-border">
        <div className="mx-auto flex h-14 items-center justify-between px-6">
          <Link href="/" className="flex items-baseline gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
            <span
              className="text-2xl font-normal"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Atelier
            </span>
            <span className="text-xs text-muted-foreground">· 工作流</span>
          </Link>
          <nav className="flex h-14 items-stretch gap-1">
            <NavTab to="/character" label="工坊" isActive={onCharacter} />
            <NavTab to="/studio" label="试稿" isActive={onStudio} />
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/settings/keys"
              aria-label="API Keys 设置"
              className={[
                'inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                onKeys ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
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
          <Route path="/settings/keys">{() => <KeysPage />}</Route>
          <Route>
            <Redirect to="/" replace />
          </Route>
        </Switch>
      </main>
    </div>
  );
}
