import type { CanvasAgentMessage, StudioAgentSession, StudioAgentTurn } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { RoundState } from '@/components/studio/RoundList';
import { isGalleryFavorited, isGalleryHidden } from '@/api/gallery';

export type GenMode = 'image' | 'video' | 'agent';
export type TimeFilter = 'all' | '1w' | '1m' | '3m';

export interface HistoryFilters {
  search: string;
  time: TimeFilter;
  modes: GenMode[];
  op: 'favorite' | 'hidden' | null;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  search: '',
  time: 'all',
  modes: [],
  op: null,
};

const DAY = 24 * 60 * 60 * 1000;
const TIME_WINDOWS: Record<Exclude<TimeFilter, 'all'>, number> = {
  '1w': 7 * DAY,
  '1m': 30 * DAY,
  '3m': 90 * DAY,
};

export interface AgentRound {
  kind: 'agent';
  turn: StudioAgentTurn;
  submittedAt: string;
  messages: CanvasAgentMessage[];
  jobs: Job[];
}

export type TimelineRound = RoundState | AgentRound;

export function roundTime(round: TimelineRound) {
  return round.kind === 'pending' ? round.startedAt : Date.parse(round.submittedAt);
}

export function mixedTimeline(manual: RoundState[], session: StudioAgentSession | null, jobs: Job[]): TimelineRound[] {
  const turns = new Map<string, AgentRound>();
  for (const turn of session?.turns ?? []) {
    turns.set(turn.turn_id, { kind: 'agent', turn, messages: [], jobs: [], submittedAt: session!.created_at });
  }
  for (const message of session?.messages ?? []) {
    const entry = message.turn_id && turns.get(message.turn_id);
    if (!entry) continue;
    if (message.role === 'user') entry.submittedAt = message.created_at;
    entry.messages.push(message);
  }
  for (const job of jobs) {
    if (job.studio_agent_session_id === session?.session_id && job.studio_agent_turn_id) turns.get(job.studio_agent_turn_id)?.jobs.push(job);
  }
  return [...manual, ...turns.values()].sort((a, b) => roundTime(a) - roundTime(b));
}

export function hasHistoryFilters(filters: HistoryFilters) {
  return Boolean(filters.search.trim() || filters.time !== 'all' || filters.modes.length || filters.op);
}

export function deriveGenMode(job: Job): GenMode {
  if (job.studio_agent_turn_id) return 'agent';
  if (job.kind === 'video') return 'video';
  return 'image';
}

/** 渲染边界对 RoundState 施加查询面板筛选。mode 缺省时回落 config.kind（乐观本地轮，恒非 skill）。 */
export function filterRounds<T extends TimelineRound>(
  rounds: T[],
  filters: HistoryFilters,
  favorites: string[],
  hidden: string[],
): T[] {
  const now = Date.now();
  const q = filters.search.trim().toLowerCase();
  return rounds.filter((r) => {
    if (q) {
      const texts = r.kind === 'agent'
        ? [...r.messages.filter(m => ['user', 'assistant', 'system'].includes(m.role)).map(m => m.text), ...r.jobs.map(j => j.prompt)]
        : [r.config?.prompt ?? ''];
      if (!texts.some(text => text.toLowerCase().includes(q))) return false;
    }
    if (filters.time !== 'all') {
      const t = roundTime(r);
      if (!Number.isFinite(t) || t < now - TIME_WINDOWS[filters.time]) return false;
    }
    if (filters.modes.length > 0) {
      const mode: GenMode = r.kind === 'agent' ? 'agent' : r.mode ?? (r.config?.kind === 'video' ? 'video' : 'image');
      if (!filters.modes.includes(mode)) return false;
    }
    if (filters.op) {
      const paths = r.kind === 'agent' ? r.jobs.flatMap(job => job.output_paths) : r.kind === 'done' ? r.imagePaths : [];
      const match =
        filters.op === 'favorite'
          ? paths.some((p) => isGalleryFavorited(p, favorites))
          : paths.some((p) => isGalleryHidden(p, hidden));
      if (!match) return false;
    }
    return true;
  });
}
