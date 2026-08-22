import type { Job } from '@/schema/jobs';
import type { RoundState } from '@/components/studio/RoundList';
import { isGalleryFavorited, isGalleryHidden } from '@/api/gallery';

export type GenMode = 'image' | 'video' | 'skill';
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

/** 来源优先、三档互斥：正式工作流原生产物归 Skill；Studio 直出及其归档副本按媒体分类。 */
export function deriveGenMode(job: Job): GenMode {
  const archivedFromStudio = typeof job.params?.archived_from_job_id === 'string';
  if (job.namespace !== 'studio' && !archivedFromStudio) return 'skill';
  if (job.kind === 'video') return 'video';
  return 'image';
}

/** 渲染边界对 RoundState 施加查询面板筛选。mode 缺省时回落 config.kind（乐观本地轮，恒非 skill）。 */
export function filterRounds(
  rounds: RoundState[],
  filters: HistoryFilters,
  favorites: string[],
  hidden: string[],
): RoundState[] {
  const now = Date.now();
  const q = filters.search.trim().toLowerCase();
  return rounds.filter((r) => {
    if (q && !(r.config?.prompt ?? '').toLowerCase().includes(q)) return false;
    if (filters.time !== 'all') {
      const t = r.kind === 'pending' ? r.startedAt : Date.parse(r.submittedAt);
      if (!Number.isFinite(t) || t < now - TIME_WINDOWS[filters.time]) return false;
    }
    if (filters.modes.length > 0) {
      const mode: GenMode = r.mode ?? (r.config?.kind === 'video' ? 'video' : 'image');
      if (!filters.modes.includes(mode)) return false;
    }
    if (filters.op) {
      const paths = r.kind === 'done' ? r.imagePaths : [];
      const match =
        filters.op === 'favorite'
          ? paths.some((p) => isGalleryFavorited(p, favorites))
          : paths.some((p) => isGalleryHidden(p, hidden));
      if (!match) return false;
    }
    return true;
  });
}
