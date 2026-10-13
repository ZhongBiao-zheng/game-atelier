import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Link } from 'wouter';

import { chooseFolder } from '@/api/folders';
import { fetchConfig, updateConfig } from '@/api/config';
import { fetchOnboardingStatus, setDataRoot } from '@/api/onboarding';
import { KeysPage } from './Keys';
import { ProfileSection } from './ProfileSection';
import { TeamLibrariesSection } from './TeamLibrariesSection';
import { HOSTED_SITE } from '@/api/connection';
import { HostedManagementNotice } from '@/components/HostedManagementNotice';
import { SwapLabel } from '@/components/ui/swap-label';

const DEFAULT_ROOT = '~/game-atelier';

const SECTIONS = [
  { id: 'settings-storage', label: '项目存放' },
  { id: 'settings-home', label: '首页展示' },
  { id: 'settings-profile', label: '显示名' },
  { id: 'settings-team', label: '团队库' },
  { id: 'settings-keys', label: 'API 密钥' },
];
const navItemClass = 'rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const sectionClass = 'scroll-mt-6 space-y-4';

export function SettingsPage() {
  if (HOSTED_SITE) return <HostedManagementNotice title="设置" />;
  return <LocalSettingsPage />;
}

function LocalSettingsPage() {
  const [savedRoot, setSavedRoot] = useState('');
  const [pendingRoot, setPendingRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keysVersion, setKeysVersion] = useState(0);
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

  // 从别处「去设置」跳过来配 Key（如画布 Agent 没有对话模型）：?section=keys 时滚到密钥区块。
  useEffect(() => {
    if (loading || new URLSearchParams(window.location.search).get('section') !== 'keys') return;
    window.document.getElementById('settings-keys')?.scrollIntoView({ block: 'start' });
  }, [loading]);

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

      <div className="mt-6 md:grid md:grid-cols-[160px_minmax(0,1fr)] md:gap-12">
      <nav aria-label="设置分区" className="mb-8 md:mb-0">
        <div className="-mx-3 flex flex-wrap gap-0.5 md:sticky md:top-6 md:flex-col">
          {SECTIONS.map(section => (
            <a key={section.id} href={`#${section.id}`} className={navItemClass}>{section.label}</a>
          ))}
          <Link href="/connection" className={navItemClass}>本机连接</Link>
        </div>
      </nav>
      <div className="min-w-0">
      <section id="settings-storage" className={`${sectionClass} pb-10`}>
        <h2 className="text-base font-medium text-foreground">项目存放</h2>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <span
                aria-label="数据目录"
                className={`min-w-0 break-all font-mono text-sm ${changed ? 'text-primary' : 'text-foreground'}`}
              >
                {loading ? '读取中...' : displayRoot || '尚未选择数据目录'}
              </span>
              {changed && (
                <span className="text-xs text-muted-foreground">未保存</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
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
                    <SwapLabel active={Boolean(saving)} on="保存中..." off="保存" />
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

      <section id="settings-home" className={`${sectionClass} border-t border-border py-10`}>
        <h2 className="text-base font-medium text-foreground">首页展示</h2>
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-foreground">展示画布出图</p>
              <p className="mt-1 text-sm text-muted-foreground">
                画布里正在显示的生成图会出现在首页；打码的不展示。
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showCanvasOnHome}
              aria-label="展示画布出图"
              disabled={togglingStudio}
              onClick={() => void toggleShowStudioOnHome()}
              className={`relative h-6 w-11 shrink-0 rounded-full border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${showCanvasOnHome ? 'bg-primary' : 'bg-secondary'}`}
            >
              <span
                aria-hidden
                className={`absolute top-0.5 size-[18px] rounded-full bg-background transition-[left] ${showCanvasOnHome ? 'left-[22px]' : 'left-0.5'}`}
              />
            </button>
          </div>
        </div>
      </section>

      <section id="settings-profile" className={`${sectionClass} border-t border-border py-10`}>
        <ProfileSection />
      </section>

      <section id="settings-team" className={`${sectionClass} border-t border-border py-10`}>
        <TeamLibrariesSection />
      </section>

      <section id="settings-keys" className={`${sectionClass} border-t border-border py-10`}>
        <h2 className="text-base font-medium text-foreground">API 密钥</h2>
        <div className="min-w-0">
          <KeysPage key={keysVersion} embedded />
        </div>
      </section>
      </div>
      </div>
    </div>
  );
}
