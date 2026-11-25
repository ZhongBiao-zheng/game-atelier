import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOnboardingStatus, type OnboardingState } from './api/onboarding';
import { DataRootPage } from './pages/onboarding/DataRoot';
import { FirstRunGuide } from './pages/onboarding/FirstRunGuide';
import { KeysPage } from './pages/settings/Keys';
import { AppShell } from '@/components/AppShell';
import { LocalConnectionGate } from '@/components/LocalConnectionGate';
import { StartupScreen } from '@/components/StartupScreen';
import { ApiError } from '@/api/http';
import { probeUpdateInstance, readPendingUpdate, savePendingUpdate, updateNavigation, updateRecoveryExpired } from '@/api/update';

export function App() {
  return <LocalConnectionGate><ConnectedApp /></LocalConnectionGate>;
}

function ConnectedApp() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const loadGeneration = useRef(0);

  const reload = useCallback(() => {
    clearTimeout(retryTimer.current);
    const generation = ++loadGeneration.current;
    const load = (attempt: number) => {
      fetchOnboardingStatus(AbortSignal.timeout(8000))
        .then(s => { if (generation === loadGeneration.current) { setState(s); setError(null); } })
        .catch(async e => {
          if (generation !== loadGeneration.current) return;
          const pending = readPendingUpdate();
          if (pending) {
            const recovering = { ...pending, restartAt: pending.restartAt ?? Date.now() };
            if (updateRecoveryExpired(recovering)) {
              savePendingUpdate(null);
              setError('服务没有自动恢复，请双击启动器');
              return;
            }
            savePendingUpdate(recovering);
            try {
              const instance = await probeUpdateInstance();
              if (generation !== loadGeneration.current) return;
              if (instance !== recovering.instance) {
                savePendingUpdate({ ...recovering, instance });
                updateNavigation.reload();
                return;
              }
            } catch { /* The executor may be restoring the previous version. */ }
            if (generation === loadGeneration.current) retryTimer.current = setTimeout(() => load(attempt + 1), 1000);
            return;
          }
          // A new instance serves its identity before the update executor commits it.
          if (e instanceof ApiError && e.status === 503 && attempt < 30) {
            retryTimer.current = setTimeout(() => load(attempt + 1), 1000);
          } else setError(String(e));
        });
    };
    load(0);
  }, []);

  const cancelLoad = useCallback(() => {
    loadGeneration.current++;
    clearTimeout(retryTimer.current);
  }, []);
  useEffect(() => {
    reload();
    return cancelLoad;
  }, [reload, cancelLoad]);

  if (error) {
    return (
      <div className="grid h-screen place-items-center bg-background p-8 text-destructive">
        {error}
      </div>
    );
  }
  if (!state) return <StartupScreen label={readPendingUpdate() ? '重启中…' : '启动中…'} />;

  // 主内容第一次出现时 200ms 淡入，接住启动页；之后在引导与主界面之间切换不再重播。
  return <div className="content-reveal">{connectedView(state, reload)}</div>;
}

function connectedView(state: OnboardingState, reload: () => void) {
  switch (state.status) {
    case 'needs_data_root':
      return <DataRootPage onComplete={reload} />;
    case 'needs_keys_repair':
      return <KeysPage mode="onboarding" onComplete={reload} />;
    case 'needs_first_key':
      if (!state.onboarding_skipped) return <FirstRunGuide onComplete={reload} />;
      return <AppShell runtimeMode={state.runtime_mode ?? 'source'} latestRelease={state.update?.update_available ? state.update.latest : null} />;
    case 'ready':
    default:
      return <AppShell runtimeMode={state.runtime_mode ?? 'source'} latestRelease={state.update?.update_available ? state.update.latest : null} />;
  }
}
