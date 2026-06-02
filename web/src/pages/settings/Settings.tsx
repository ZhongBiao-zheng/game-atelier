import { useEffect, useState } from 'react';
import { FolderOpen, Save } from 'lucide-react';

import { chooseFolder } from '@/api/folders';
import { fetchOnboardingStatus, setDataRoot } from '@/api/onboarding';
import { KeysPage } from './Keys';

const DEFAULT_ROOT = '~/game-atelier';

export function SettingsPage() {
  const [dataRoot, setDataRootInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keysVersion, setKeysVersion] = useState(0);

  useEffect(() => {
    fetchOnboardingStatus()
      .then((state) => setDataRootInput(state.data_root ?? DEFAULT_ROOT))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function saveDataRoot() {
    const next = dataRoot.trim();
    if (!next) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const saved = await setDataRoot(next);
      setDataRootInput(saved.data_root);
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
      const picked = await chooseFolder('选择存放文件夹', dataRoot || DEFAULT_ROOT);
      if (picked) setDataRootInput(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChoosing(false);
    }
  }

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto space-y-8">
      <h1
        className="text-2xl text-foreground"
        style={{ fontFamily: "'Instrument Serif', serif" }}
      >
        设置
      </h1>

      <section className="rounded-lg border border-border bg-card/55 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-base font-medium text-foreground">项目存放地址</h2>
        </div>
        <div>
          <label htmlFor="data-root" className="block text-sm mb-2 text-muted-foreground">
            数据目录
          </label>
          <div className="flex gap-2">
            <input
              id="data-root"
              value={dataRoot}
              readOnly
              disabled={loading}
              className="w-full rounded-md border border-input bg-background/40 px-3 py-2 font-mono text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              placeholder="尚未选择项目文件夹"
            />
            <button
              type="button"
              onClick={pickDataRoot}
              disabled={loading || saving || choosing}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-background/35 px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <FolderOpen className="size-4" aria-hidden />
              {choosing ? '选择中...' : '选择文件夹'}
            </button>
            <button
              type="button"
              onClick={saveDataRoot}
              disabled={!dataRoot.trim() || loading || saving || choosing}
              className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Save className="size-4" aria-hidden />
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            这里控制角色、项目、历史 job 和 API Key 所在的根目录。
          </p>
        </div>
        {message && <div className="text-sm text-emerald-600">{message}</div>}
        {error && <div className="text-sm text-destructive">{error}</div>}
      </section>

      <section>
        <KeysPage key={keysVersion} embedded />
      </section>
    </div>
  );
}
