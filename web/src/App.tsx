import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { fetchOnboardingStatus, type OnboardingState } from './api/onboarding';
import { DataRootPage } from './pages/onboarding/DataRoot';
import { KeysPage } from './pages/settings/Keys';
import { AppShell } from '@/components/AppShell';

const BatchMaterialPrototype = import.meta.env.DEV
  ? lazy(() => import('@/pages/prototype/CanvasBatchMaterialPrototype'))
  : null;

export function App() {
  // The prototype is local-only: no onboarding, persistence, jobs or provider calls.
  if (BatchMaterialPrototype && window.location.pathname === '/canvas/prototype-batch-materials') {
    return <Suspense fallback={<div className="p-8 text-muted-foreground">加载原型…</div>}><BatchMaterialPrototype /></Suspense>;
  }
  return <RuntimeApp />;
}

function RuntimeApp() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchOnboardingStatus()
      .then(s => { setState(s); setError(null); })
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (error) {
    return (
      <div className="grid h-screen place-items-center bg-background p-8 text-destructive">
        {error}
      </div>
    );
  }
  if (!state) {
    return (
      <div className="grid h-screen place-items-center bg-background text-muted-foreground">
        <span className="font-display text-display italic">加载中…</span>
      </div>
    );
  }

  switch (state.status) {
    case 'needs_data_root':
      return <DataRootPage onComplete={reload} />;
    case 'needs_keys_repair':
      return <KeysPage mode="onboarding" onComplete={reload} />;
    case 'needs_first_key':
    case 'ready':
    default:
      return <AppShell />;
  }
}
