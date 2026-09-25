import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { X } from 'lucide-react';

import { fetchProfile, teamAssetThumbUrl } from '@/api/teamLibraries';
import {
  dispatchTeamAssetAction,
  type TeamAssetAction,
  teamAssetActionSearch,
} from '@/lib/teamAssetActions';
import type { TeamLibraryChangeEvent } from '@/schema/teamLibrary';

/** AppShell 持有句柄：SSE `team-library-changed` 交给 notify，SSE（重）连上时 refreshProfile。 */
export interface TeamShareReminderHandle {
  notify: (event: TeamLibraryChangeEvent) => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const REMINDED_KEY = 'atelier:team-reminded';
const REMINDED_LIMIT = 500;
const MERGE_WINDOW_MS = 3000;
const MERGE_THRESHOLD = 3;
const MAX_SINGLE_TOASTS = 3;
const VISIBLE_MS = 8000;
const THUMB_WIDTH = 96;

type SingleToast = { id: number; type: 'single'; event: TeamLibraryChangeEvent; at: number };
type MergedToast = { id: number; type: 'merged'; count: number };
type Toast = SingleToast | MergedToast;

function readReminded(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(REMINDED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeReminded(ids: string[]): void {
  try {
    window.localStorage.setItem(REMINDED_KEY, JSON.stringify(ids.slice(-REMINDED_LIMIT)));
  } catch { /* 存不下只影响跨会话去重，本会话仍由内存集合去重。 */ }
}

function isReminded(session: ReadonlySet<string>, assetId: string): boolean {
  return session.has(assetId) || readReminded().includes(assetId);
}

/** 作者（已 trim）；不该提醒的事件返回 null。是不是本人另判，因为显示名可能要现取。
 *
 * 只认 added：服务端把「条目首次可用」（新增即 ready，或网盘同步到一半 incomplete → ready）都发成 added，
 * 其余字段变化（改标题、改标签）发 updated，不打扰人。 */
function reminderAuthor(event: TeamLibraryChangeEvent): string | null {
  if (event.change !== 'added' || event.status !== 'ready' || event.kind === 'raw') return null;
  return event.author?.trim() || null;
}

function actionFor(event: TeamLibraryChangeEvent): TeamAssetAction {
  return {
    library_id: event.library_id,
    asset_id: event.asset_id,
    action: event.kind === 'generation' ? 'reproduce' : 'open',
  };
}

export const TeamShareReminder = forwardRef<TeamShareReminderHandle>(function TeamShareReminder(_props, ref) {
  const [, setLocation] = useLocation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const burstRef = useRef<number[]>([]);
  const nextIdRef = useRef(0);
  const sessionRemindedRef = useRef(new Set<string>());
  const displayNameRef = useRef<string | null>(null);
  const profileRequestRef = useRef(0);

  const commit = useCallback((next: Toast[]) => {
    const kept = new Set(next.map(toast => toast.id));
    for (const [id, timer] of timersRef.current) {
      if (!kept.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const dismiss = useCallback((id: number) => {
    // 合并条关掉后清空 burst：同一波里后续的分享从单条重新算，不再把已合并过的计进新合并条。
    if (toastsRef.current.some(toast => toast.id === id && toast.type === 'merged')) burstRef.current = [];
    commit(toastsRef.current.filter(toast => toast.id !== id));
  }, [commit]);

  const scheduleDismiss = useCallback((id: number) => {
    clearTimeout(timersRef.current.get(id));
    timersRef.current.set(id, setTimeout(() => dismiss(id), VISIBLE_MS));
  }, [dismiss]);

  const refreshProfile = useCallback(async () => {
    const request = ++profileRequestRef.current;
    try {
      const profile = await fetchProfile();
      // 只认最新一次请求：先发后到的旧响应不能盖掉新显示名。
      if (request === profileRequestRef.current) displayNameRef.current = profile?.display_name?.trim() || null;
    } catch { /* 读不到显示名时沿用上次的，宁可多提醒也不漏。 */ }
  }, []);

  const show = useCallback((event: TeamLibraryChangeEvent, at: number) => {
    const burst = [...burstRef.current.filter(prior => at - prior < MERGE_WINDOW_MS), at];
    burstRef.current = burst;
    const current = toastsRef.current;
    if (burst.length <= MERGE_THRESHOLD) {
      const id = nextIdRef.current++;
      const next: Toast[] = [...current, { id, type: 'single', event, at }];
      const singles = next.filter(toast => toast.type === 'single');
      const dropped = new Set(singles.slice(0, Math.max(0, singles.length - MAX_SINGLE_TOASTS)).map(toast => toast.id));
      commit(next.filter(toast => !dropped.has(toast.id)));
      scheduleDismiss(id);
      return;
    }
    // 本波超过阈值：本波已弹出的单条并入合并条，窗口外的旧单条原样保留。
    const inBurst = current.filter((toast): toast is SingleToast => toast.type === 'single' && at - toast.at < MERGE_WINDOW_MS);
    const folded = new Set(inBurst.map(toast => toast.id));
    const merged = current.find((toast): toast is MergedToast => toast.type === 'merged');
    const id = merged?.id ?? nextIdRef.current++;
    const count = (merged?.count ?? 0) + inBurst.length + 1;
    commit([
      ...current.filter(toast => toast.type === 'single' && !folded.has(toast.id)),
      { id, type: 'merged', count } satisfies MergedToast,
    ]);
    scheduleDismiss(id);
  }, [commit, scheduleDismiss]);

  const notify = useCallback(async (event: TeamLibraryChangeEvent) => {
    const author = reminderAuthor(event);
    const reminded = sessionRemindedRef.current;
    if (!author || author === displayNameRef.current || isReminded(reminded, event.asset_id)) return;
    const at = Date.now();
    // 作者与缓存的显示名不同：可能是刚设好显示名后的第一次分享，现取一次再判，免得提醒到自己。
    await refreshProfile();
    if (author === displayNameRef.current || isReminded(reminded, event.asset_id)) return;
    reminded.add(event.asset_id);
    writeReminded([...readReminded(), event.asset_id]);
    show(event, at);
  }, [refreshProfile, show]);

  useImperativeHandle(ref, () => ({ notify, refreshProfile }), [notify, refreshProfile]);

  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const runAction = (toast: SingleToast) => {
    const action = actionFor(toast.event);
    if (!dispatchTeamAssetAction(action)) setLocation(`/studio${teamAssetActionSearch(action)}`);
    dismiss(toast.id);
  };

  return (
    // 右上角、顶栏（lg:h-20）下方：避开 Studio 底部输入壳与画布右下的批量结果 / MiniMap。
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-24 right-4 z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow"
        >
          {toast.type === 'single' ? (
            <>
              <ReminderThumb event={toast.event} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-muted-foreground">{toast.event.author}</p>
                {toast.event.title && <p className="truncate text-sm" title={toast.event.title}>{toast.event.title}</p>}
              </div>
              <button
                type="button"
                onClick={() => runAction(toast)}
                className="shrink-0 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {toast.event.kind === 'generation' ? '复刻' : '看看'}
              </button>
            </>
          ) : (
            <p className="min-w-0 flex-1 truncate text-sm">团队库新增 {toast.count} 条</p>
          )}
          <button
            type="button"
            aria-label="关闭"
            onClick={() => dismiss(toast.id)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
});

function ReminderThumb({ event }: { event: TeamLibraryChangeEvent }) {
  const [broken, setBroken] = useState(false);
  if (broken || !(event.mime_type ?? '').startsWith('image/')) return null;
  return (
    <img
      src={teamAssetThumbUrl(event.library_id, event.asset_id, THUMB_WIDTH)}
      alt=""
      onError={() => setBroken(true)}
      className="size-10 shrink-0 rounded-md bg-secondary object-cover"
    />
  );
}
