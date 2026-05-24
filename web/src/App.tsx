import { useCallback, useEffect, useState } from 'react';
import { fetchOnboardingStatus, type OnboardingState } from './api/onboarding';
import { DataRootPage } from './pages/onboarding/DataRoot';
import { KeysPage } from './pages/settings/Keys';
import { MainApp } from './MainApp';

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
    case 'needs_first_key':
    case 'needs_keys_repair':
      return <KeysPage mode="onboarding" onComplete={reload} />;
    case 'needs_uv':
    case 'needs_venv':
      return (
        <div className="max-w-2xl mx-auto p-8 space-y-4">
          <h2 className="text-xl font-medium">需要终端操作</h2>
          <p className="text-stone-600">在终端按下面提示完成后再回到这里刷新：</p>
          <pre className="bg-stone-100 p-4 text-sm whitespace-pre-wrap break-all rounded">
            {state.next_action}
          </pre>
          <button
            type="button"
            onClick={reload}
            className="px-4 py-2 bg-stone-900 text-white rounded"
          >
            重新检查
          </button>
        </div>
      );
    case 'ready':
    default:
      return <MainApp />;
  }
}
