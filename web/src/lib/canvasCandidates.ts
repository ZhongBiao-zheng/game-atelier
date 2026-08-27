import type { Job } from '@/schema/jobs';

export type CanvasCandidateEntry = {
  job: Job;
  candidate: NonNullable<Job['canvas_run']>['candidates'][number];
};

export type CanvasCandidatePresentation = {
  current: CanvasCandidateEntry[];
  history: CanvasCandidateEntry[];
};

/**
 * Fold immutable run history into the slots currently shown by the result node.
 * A retry re-runs the whole batch, so its candidates overwrite the same indices; a
 * dismissed latest entry hides that slot instead of revealing stale content underneath.
 */
export function presentCanvasCandidates(jobs: readonly Job[]): CanvasCandidatePresentation {
  const entries: CanvasCandidateEntry[] = jobs.flatMap(job => (
    job.canvas_run?.candidates.map(candidate => ({ job, candidate })) ?? []
  ));
  const latestByIndex = new Map<number, CanvasCandidateEntry>();
  for (const entry of entries) latestByIndex.set(entry.candidate.index, entry);
  const latestIds = new Set(
    [...latestByIndex.values()].map(entry => entry.candidate.candidate_id),
  );
  return {
    current: [...latestByIndex.values()]
      .filter(entry => !entry.candidate.dismissed_at)
      .sort((left, right) => left.candidate.index - right.candidate.index),
    history: entries
      .filter(entry => !latestIds.has(entry.candidate.candidate_id))
      .reverse(),
  };
}
