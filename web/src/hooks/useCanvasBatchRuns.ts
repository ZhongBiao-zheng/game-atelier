import { useCallback, useEffect, useRef, useState } from 'react';
import { listCanvasBatches } from '@/api/canvasBatch';
import { getCanvasDocument, listCanvasJobs } from '@/api/canvas';
import type { CanvasDocument } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import { isCanvasBatchActive, type CanvasBatchRun } from '@/schema/canvasBatch';

/** Poll the plan even between Jobs; a gap must not turn off generation synchronization. */
export function useCanvasBatchRuns(projectId: string, acceptJobs: (jobs: Job[]) => void,
  mergeDocument: (document: CanvasDocument, runIds: ReadonlySet<string>, nodeIds?: ReadonlySet<string>) => void,
  onError: (message: string) => void) {
  const [runs, setRuns] = useState<CanvasBatchRun[]>([]);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  const acceptRun = useCallback((run: CanvasBatchRun) => {
    epoch.current += 1;
    setRuns(current => [run, ...current.filter(candidate => candidate.batch_id !== run.batch_id)]);
    setRefresh(value => value + 1);
  }, []);
  useEffect(() => { setRuns([]); epoch.current += 1; }, [projectId]);
  const active = runs.find(isCanvasBatchActive);
  const activeId = active?.batch_id;
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const requestedEpoch = epoch.current;
      try {
        const remote = await listCanvasBatches(projectId);
        if (canceled || requestedEpoch !== epoch.current) return;
        if (activeId || remote.some(isCanvasBatchActive)) {
          const jobs = await listCanvasJobs(projectId);
          const document = await getCanvasDocument(projectId);
          if (canceled || requestedEpoch !== epoch.current) return;
          mergeDocument(document,
            new Set(remote.flatMap(run => run.executions.map(entry => entry.run_id))),
            new Set(remote.flatMap(run => run.executions.flatMap(entry => entry.result_node_id ? [entry.result_node_id] : []))));
          acceptJobs(jobs);
        }
        setRuns(remote);
      } catch (error) {
        if (!canceled) onError((error as Error).message);
      } finally {
        if (!canceled && activeId) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [projectId, activeId, refresh, acceptJobs, mergeDocument, onError]);
  return { runs, active, acceptRun };
}
