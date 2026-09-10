import { useCallback, useEffect, useState } from 'react';
import { fetchOnboardingStatus, type OnboardingState } from './api/onboarding';
import { DataRootPage } from './pages/onboarding/DataRoot';
import { KeysPage } from './pages/settings/Keys';
import { AppShell } from '@/components/AppShell';
import { LocalConnectionGate } from '@/components/LocalConnectionGate';
import { HOSTED_SITE } from '@/api/connection';

export function App() {
  return <LocalConnectionGate><ConnectedApp /></LocalConnectionGate>;
}

function ConnectedApp() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchOnboardingStatus()
      .then(s => { setState(s); setError(null); })
      .catch(e => setError(String(e)));
  }, []);

  // 初始化状态含本机路径，属管理端点；网站能配对成功就说明本机已初始化，直接进界面。
  useEffect(() => { if (!HOSTED_SITE) reload(); }, [reload]);

  if (HOSTED_SITE) return <AppShell />;
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
