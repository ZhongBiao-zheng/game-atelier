import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';

import { chooseFolder } from '@/api/folders';
import { fetchOnboardingStatus, setDataRoot } from '@/api/onboarding';
import { KeysPage } from './Keys';

const DEFAULT_ROOT = '~/game-atelier';

export function SettingsPage() {
  const [savedRoot, setSavedRoot] = useState('');
  const [pendingRoot, setPendingRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keysVersion, setKeysVersion] = useState(0);

  useEffect(() => {
    fetchOnboardingStatus()
      .then((state) => setSavedRoot(state.data_root ?? DEFAULT_ROOT))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const changed = pendingRoot !== null && pendingRoot !== savedRoot;
  const displayRoot = pendingRoot ?? savedRoot;

  async function saveDataRoot() {
    if (!changed || !pendingRoot) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const saved = await setDataRoot(pendingRoot);
      setSavedRoot(saved.data_root);
      setPendingRoot(null);
      setKeysVersion((version) => version + 1);
      setMessage('项目存放地址已更新，API Key 已重新读取新目录。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function pickDataRoot() {
    setChoosing(true);
    setMessage(null);
    setError(null);
    try {
      const picked = await chooseFolder('选择存放文件夹', displayRoot || DEFAULT_ROOT);
      if (picked) setPendingRoot(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChoosing(false);
    }
  }

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto">
      <h1 className="font-display text-display text-foreground">设置</h1>

      <section className="grid gap-6 py-10 md:grid-cols-[220px_1fr] md:gap-12">
        <div>
          <h2 className="text-xs uppercase tracking-label text-muted-foreground/70">项目存放</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            角色、项目、历史 job 和 API Key 所在的根目录。
          </p>
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-label="数据目录"
              className={`min-w-0 break-all font-mono text-sm ${changed ? 'text-primary' : 'text-foreground'}`}
            >
              {loading ? '读取中...' : displayRoot || '尚未选择项目文件夹'}
            </span>
            {changed && (
              <span className="text-xs uppercase tracking-label text-muted-foreground/70">未保存</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={pickDataRoot}
              disabled={loading || saving || choosing}
              className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <FolderOpen className="size-4" aria-hidden />
              {choosing ? '选择中...' : '更换文件夹'}
            </button>
            {changed && (
              <>
                <button
                  type="button"
                  onClick={saveDataRoot}
                  disabled={saving}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background"
                >
                  {saving ? '保存中...' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingRoot(null)}
                  disabled={saving}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  撤销
                </button>
              </>
            )}
          </div>
          {message && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="size-1.5 rounded-full bg-[color:var(--status-done)]" aria-hidden />
              {message}
            </div>
          )}
          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>
      </section>

      <section className="grid gap-6 border-t border-border py-10 md:grid-cols-[220px_1fr] md:gap-12">
        <div>
          <h2 className="text-xs uppercase tracking-label text-muted-foreground/70">API 密钥</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            图像 / 视频生成服务的访问凭证，按供应商管理。
          </p>
        </div>
        <div className="min-w-0">
          <KeysPage key={keysVersion} embedded />
        </div>
      </section>
    </div>
  );
}
