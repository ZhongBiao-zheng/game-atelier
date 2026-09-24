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
  notify: (event: TeamLibraryChangeEvent) => void;
  refreshProfile: () => void;
}

const REMINDED_KEY = 'atelier:team-reminded';
const REMINDED_LIMIT = 500;
const MERGE_WINDOW_MS = 3000;
const MERGE_THRESHOLD = 3;
const MAX_SINGLE_TOASTS = 3;
const VISIBLE_MS = 8000;
const THUMB_WIDTH = 96;

type SingleToast = { id: number; type: 'single'; event: TeamLibraryChangeEvent };
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

function isTeammateShare(event: TeamLibraryChangeEvent, displayName: string | null): boolean {
  if (event.change === 'removed' || event.status !== 'ready' || event.kind === 'raw') return false;
  const author = event.author?.trim();
  return Boolean(author) && author !== displayName;
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
    commit(toastsRef.current.filter(toast => toast.id !== id));
  }, [commit]);

  const scheduleDismiss = useCallback((id: number) => {
    clearTimeout(timersRef.current.get(id));
    timersRef.current.set(id, setTimeout(() => dismiss(id), VISIBLE_MS));
  }, [dismiss]);

  const refreshProfile = useCallback(() => {
    const request = ++profileRequestRef.current;
    fetchProfile()
      .then(profile => {
        if (request === profileRequestRef.current) displayNameRef.current = profile?.display_name?.trim() || null;
      })
      .catch(() => { /* 读不到显示名时沿用上次的，宁可多提醒也不漏。 */ });
  }, []);

  const notify = useCallback((event: TeamLibraryChangeEvent) => {
    if (!isTeammateShare(event, displayNameRef.current)) return;
    const reminded = readReminded();
    if (sessionRemindedRef.current.has(event.asset_id) || reminded.includes(event.asset_id)) return;
    sessionRemindedRef.current.add(event.asset_id);
    writeReminded([...reminded, event.asset_id]);

    const now = Date.now();
    const burst = [...burstRef.current.filter(at => now - at < MERGE_WINDOW_MS), now];
    burstRef.current = burst;

    const current = toastsRef.current;
    const merged = current.find((toast): toast is MergedToast => toast.type === 'merged');
    if (merged) {
      commit(current.map(toast => (toast.id === merged.id ? { ...merged, count: merged.count + 1 } : toast)));
      scheduleDismiss(merged.id);
      return;
    }
    const id = nextIdRef.current++;
    if (burst.length > MERGE_THRESHOLD) {
      commit([{ id, type: 'merged', count: burst.length }]);
    } else {
      commit([...current, { id, type: 'single', event } satisfies SingleToast].slice(-MAX_SINGLE_TOASTS));
    }
    scheduleDismiss(id);
  }, [commit, scheduleDismiss]);

  useImperativeHandle(ref, () => ({ notify, refreshProfile }), [notify, refreshProfile]);

  useEffect(() => {
    refreshProfile();
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
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
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
