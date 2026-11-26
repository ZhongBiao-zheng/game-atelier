import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOnboardingStatus, type OnboardingState } from './api/onboarding';
import { FirstRunGuide } from './pages/onboarding/FirstRunGuide';
import { DiagnosticsExport } from './pages/settings/DiagnosticsExport';
import { AppShell } from '@/components/AppShell';
import { LocalConnectionGate } from '@/components/LocalConnectionGate';
import { StartupScreen } from '@/components/StartupScreen';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/api/http';
import { errorText } from '@/lib/errorText';
import { shellLogOpener } from '@/lib/desktopShell';
import { probeUpdateInstance, readPendingUpdate, savePendingUpdate, updateNavigation, updateRecoveryExpired } from '@/api/update';

/** 首屏状态读取失败先静默重试几次（服务刚起、磁盘慢时常见），仍失败才露错误。 */
const STATUS_RETRY_DELAYS_MS = [1000, 3000];
const NOT_RECOVERED = 'Cobrush 没有自动恢复，请重新打开 Cobrush';

export function App() {
  return <LocalConnectionGate><ConnectedApp /></LocalConnectionGate>;
}

function ConnectedApp() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<{ message: string; canExport: boolean } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const loadGeneration = useRef(0);

  const reload = useCallback(() => {
    clearTimeout(retryTimer.current);
    setError(null);
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
              setError({ message: NOT_RECOVERED, canExport: e instanceof ApiError && e.status > 0 });
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
          } else if (attempt < STATUS_RETRY_DELAYS_MS.length) {
            retryTimer.current = setTimeout(() => load(attempt + 1), STATUS_RETRY_DELAYS_MS[attempt]);
          } else setError({
            message: errorText(e, '暂时读不到 Cobrush 的状态'),
            canExport: e instanceof ApiError && e.status > 0,
          });
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

  if (error) return <StartupError {...error} onRetry={reload} />;
  if (!state) return <StartupScreen label={readPendingUpdate() ? '重启中…' : '启动中…'} />;

  // 主内容第一次出现时 200ms 淡入，接住启动页；之后在引导与主界面之间切换不再重播。
  return <div className="content-reveal">{connectedView(state, reload)}</div>;
}

function StartupError({ message, canExport, onRetry }: { message: string; canExport: boolean; onRetry: () => void }) {
  const openLog = shellLogOpener();
  return <StartupScreen label="暂时打不开 Cobrush">
    <p role="alert" className="break-words text-sm text-pretty text-muted-foreground">{message}</p>
    <div className="flex flex-wrap items-center justify-center gap-2">
      {openLog && <Button variant="outline" onClick={openLog}>查看日志</Button>}
      {canExport && <DiagnosticsExport />}
      <Button onClick={onRetry}>重试</Button>
    </div>
  </StartupScreen>;
}

function connectedView(state: OnboardingState, reload: () => void) {
  switch (state.status) {
    case 'needs_first_key':
      // 供应商配置刚因损坏被备份：即使之前点过「稍后」也回到引导，说明一次。
      if (!state.onboarding_skipped || state.keys_recovered) {
        return <FirstRunGuide onComplete={reload} recovered={Boolean(state.keys_recovered)} />;
      }
      return <AppShell runtimeMode={state.runtime_mode ?? 'source'} latestRelease={state.update?.update_available ? state.update.latest : null} />;
    case 'ready':
    default:
      return <AppShell runtimeMode={state.runtime_mode ?? 'source'} latestRelease={state.update?.update_available ? state.update.latest : null} />;
  }
}
