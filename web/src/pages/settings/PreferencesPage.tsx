import { useEffect, useRef, useState } from 'react';
import { CheckIcon, FolderOpenIcon } from '@/components/ui/icons';

import { chooseFolder } from '@/api/folders';
import { fetchConfig, updateConfig } from '@/api/config';
import { changeDataRoot, fetchDataRoot, type DataRootMove } from '@/api/onboarding';
import { errorText } from '@/lib/errorText';
import { moveLabel } from '@/lib/dataRootMove';
import { ProfileSection } from './ProfileSection';
import { DiagnosticsExport } from './DiagnosticsExport';
import { SwapLabel } from '@/components/ui/swap-label';
import { Switch } from '@/components/ui/switch';
import { UpdateSettings } from '@/components/UpdateControl';

import { AppearanceSection } from './appearance/AppearanceSection';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { useRetained } from '@/components/ui/retained';

const DEFAULT_ROOT = '~/game-atelier';
const MOVE_POLL_MS = 500;
const moving = (move: DataRootMove | null) => move?.phase === 'copying' || move?.phase === 'verifying';


export function PreferencesPage() {
  const [root, setRoot] = useState('');
  const [move, setMove] = useState<DataRootMove | null>(null);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [lastTarget, setLastTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shownError = useRetained(error);
  // 只提示本次会话里发起的更换结果；打开页面时看到的是上一次的旧状态，不重复报。
  const startedHere = useRef(false);
  // 首页展示画布出图开关（应用级设置，默认开）。乐观切换，失败回滚。
  const [showCanvasOnHome, setShowCanvasOnHome] = useState(true);
  const [togglingStudio, setTogglingStudio] = useState(false);

  useEffect(() => {
    fetchDataRoot()
      .then((state) => { setRoot(state.data_root || DEFAULT_ROOT); if (moving(state.move)) { startedHere.current = true; setMove(state.move); } })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
    fetchConfig()
      .then((cfg) => setShowCanvasOnHome(cfg.show_canvas_on_home))
      .catch(() => {});
  }, []);

  // 复制在服务端后台进行：轮询进度，直到完成或失败。
  const inProgress = moving(move);
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(() => {
      fetchDataRoot().then((state) => { setMove(state.move); setRoot(state.data_root); }).catch(() => {});
    }, MOVE_POLL_MS);
    return () => clearInterval(timer);
  }, [inProgress]);
  useEffect(() => {
    if (move?.phase === 'failed' && startedHere.current) setError(move.error ?? '迁移没有完成');
  }, [move]);

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

  async function startChange(target: string) {
    setError(null);
    setCopied(false);
    setLastTarget(target);
    startedHere.current = true;
    try {
      const state = await changeDataRoot(target);
      setRoot(state.data_root);
      setMove(state.move);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function pickDataRoot() {
    setChoosing(true);
    setError(null);
    try {
      const picked = await chooseFolder('选择数据目录', root || DEFAULT_ROOT);
      if (picked && picked !== root) await startChange(picked);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChoosing(false);
    }
  }

  async function copyDetail() {
    if (!move?.detail) return;
    await navigator.clipboard?.writeText(move.detail).catch(() => {});
    setCopied(true);
  }

  const done = startedHere.current && move?.phase === 'done';
  const failed = startedHere.current && move?.phase === 'failed';

  return <div className="w-full max-w-[880px] space-y-6">
    <AppearanceSection />
    <section id="storage" aria-labelledby="storage-title" className="scroll-mt-6 space-y-2">
      <h2 id="storage-title" className="px-1 text-xs font-normal text-muted-foreground">存储</h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4.5 py-3.5">
          <span className="text-sm">数据目录</span>
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span aria-label="数据目录" className="min-w-0 break-all font-mono text-sm text-muted-foreground">
              {loading ? '加载中…' : root}
            </span>
            {done && <span role="status" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon size="sm" aria-hidden />{move?.mode === 'copy' ? '已迁移，原目录未删除' : '已切换'}
            </span>}
            {inProgress && move && <span role="status" className="text-xs tabular-nums text-muted-foreground">{moveLabel(move)}</span>}
            <Button variant="outline" size="sm" type="button" onClick={() => void pickDataRoot()} disabled={loading || choosing || inProgress}>
              <FolderOpenIcon size="sm" aria-hidden /><SwapLabel active={choosing} on="选择中…" off="更换文件夹" />
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 px-4.5 py-3.5">
          <span className="text-sm">首页展示画布出图</span>
          <Switch checked={showCanvasOnHome} aria-label="首页展示画布出图" disabled={togglingStudio} onCheckedChange={() => void toggleShowStudioOnHome()} />
        </div>
        <div className="flex items-center justify-between gap-3 px-4.5 py-3.5">
          <span className="text-sm">故障排查</span>
          <DiagnosticsExport />
        </div>
      </div>
      {/* 报错展开出现，不把下面的分组一下顶开。 */}
      <Collapse open={Boolean(error)}>
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">{shownError}</p>
          {failed && lastTarget && <Button variant="outline" size="sm" type="button" onClick={() => void startChange(lastTarget)}>重试</Button>}
          {failed && move?.detail && <Button variant="ghost" size="sm" type="button" onClick={() => void copyDetail()}>
            <SwapLabel active={copied} on="已复制" off="复制详情" />
          </Button>}
        </div>
      </Collapse>
    </section>
    <ProfileSection />
    <UpdateSettings />
  </div>;
}
