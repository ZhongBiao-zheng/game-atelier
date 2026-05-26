import { useCallback, useEffect, useState } from 'react';
import { fetchOnboardingStatus, type OnboardingState } from './api/onboarding';
import { DataRootPage } from './pages/onboarding/DataRoot';
import { KeysPage } from './pages/settings/Keys';
import { MinViewportGuard } from '@/components/MinViewportGuard';
import { AppShell } from '@/components/AppShell';

export function App() {
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
      <div className="grid h-screen place-items-center bg-background p-8 text-red-500">
        {error}
      </div>
    );
  }
  if (!state) {
    return (
      <div className="grid h-screen place-items-center bg-background text-muted-foreground">
        <span className="font-[var(--font-display)] italic text-2xl">加载中…</span>
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
      return (
        <MinViewportGuard>
          <AppShell />
        </MinViewportGuard>
      );
  }
}
