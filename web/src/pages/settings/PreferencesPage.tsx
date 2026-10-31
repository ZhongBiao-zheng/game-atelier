import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';

import { chooseFolder } from '@/api/folders';
import { fetchConfig, updateConfig } from '@/api/config';
import { fetchOnboardingStatus, setDataRoot } from '@/api/onboarding';
import { ProfileSection } from './ProfileSection';
import { SwapLabel } from '@/components/ui/swap-label';
import { Switch } from '@/components/ui/switch';
import { UpdateSettings } from '@/components/UpdateControl';

import { AppearanceSection } from './appearance/AppearanceSection';
import { Button } from '@/components/ui/button';

const DEFAULT_ROOT = '~/game-atelier';


export function PreferencesPage() {
  const [savedRoot, setSavedRoot] = useState('');
  const [pendingRoot, setPendingRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 首页展示画布出图开关（应用级设置，默认开）。乐观切换，失败回滚。
  const [showCanvasOnHome, setShowCanvasOnHome] = useState(true);
  const [togglingStudio, setTogglingStudio] = useState(false);

  useEffect(() => {
    fetchOnboardingStatus()
      .then((state) => setSavedRoot(state.data_root ?? DEFAULT_ROOT))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    fetchConfig()
      .then((cfg) => setShowCanvasOnHome(cfg.show_canvas_on_home))
      .catch(() => {});
  }, []);

  async function toggleShowStudioOnHome() {
    const next = !showCanvasOnHome;
    setShowCanvasOnHome(next);
    setTogglingStudio(true);
    try {
      await updateConfig({ show_canvas_on_home: next });
    } catch {
      setShowCanvasOnHome(!next);
    } finally {
      setTogglingStudio(false);
    }
  }

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

  return <div className="w-full max-w-[880px] space-y-6">
    <AppearanceSection />
    <section id="storage" aria-labelledby="storage-title" className="scroll-mt-6 space-y-2">
      <h2 id="storage-title" className="px-1 text-xs font-normal text-muted-foreground">存储</h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4.5 py-3.5">
          <span className="text-sm">项目存放</span>
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span aria-label="数据目录" className="min-w-0 break-all font-mono text-sm text-muted-foreground">
              {loading ? '读取中…' : displayRoot || '尚未选择数据目录'}
            </span>
            {changed && <span className="text-xs text-muted-foreground">未保存</span>}
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" type="button" onClick={pickDataRoot} disabled={loading || saving || choosing}
               >
                <FolderOpen className="size-3.5" aria-hidden />{choosing ? '选择中…' : '更换文件夹'}
              </Button>
              {changed && <>
                <Button variant="default" size="sm" type="button" onClick={saveDataRoot} disabled={saving}
                 >
                  <SwapLabel active={saving} on="保存中..." off="保存" />
                </Button>
                <Button variant="bare" type="button" onClick={() => setPendingRoot(null)} disabled={saving}
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary/60 disabled:opacity-50">撤销</Button>
              </>}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 px-4.5 py-3.5">
          <span className="text-sm">首页展示画布出图</span>
          <Switch checked={showCanvasOnHome} aria-label="首页展示画布出图" disabled={togglingStudio} onCheckedChange={() => void toggleShowStudioOnHome()} />
        </div>
      </div>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
    <ProfileSection />
    <UpdateSettings />
  </div>;
}
