import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getCanvasDocument, listCanvasJobs } from '@/api/canvas';
import { useSSE } from '@/hooks/useSSE';
import { acceptCanvasJobs, upsertCanvasJob } from '@/pages/canvasEditorModel';
import type { CanvasDocument } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';

export interface CanvasJobSync {
  jobs: Job[];
  /** 服务端全量列表并进本地：首屏加载和兜底轮询都走它。 */
  acceptJobs: (remote: Job[]) => void;
  /** 本地刚提交 / 刚改过的一条 job，立刻可见，且让随后才回来的轮询结果不许把它盖回去。 */
  applyLocalJob: (job: Job) => void;
  /** 切项目时清掉「哪些 run / 候选已经并过文档」的记账。 */
  reset: () => void;
}

/** 画布出图记录的同步：SSE 通知 + 兜底轮询 + 出图结果并回文档。
 *
 *  抽出来的边界是「谁写 jobs」：epoch、已同步 run 的记账、轮询与 SSE 订阅，只有这里会碰。
 *  `mergeRunDocument` 反过来只写 document，由调用方给——所以这个 hook 不需要拿到画布文档的
 *  任何 state 或 ref。 */
export function useCanvasJobSync({
  projectId,
  mergeRunDocument,
  onError,
}: {
  projectId: string;
  mergeRunDocument: (remote: CanvasDocument, runIds: ReadonlySet<string>, nodeIds?: ReadonlySet<string>) => void;
  onError: (message: string) => void;
}): CanvasJobSync {
  const [jobs, setJobs] = useState<Job[]>([]);
  // 每一次本地乐观写入都推进 epoch。轮询在发请求前拍下 epoch，响应落地时若 epoch 变了，
  // 说明这份列表已经落后于本地，只能并进去，不能整体赋值。见 acceptCanvasJobs。
  const jobsEpoch = useRef(0);
  const syncedTerminalRuns = useRef(new Set<string>());
  const syncedCandidateVersionIds = useRef(new Set<string>());

  const acceptJobs = useCallback((remote: Job[]) => {
    setJobs(current => acceptCanvasJobs(current, remote));
  }, []);

  const applyLocalJob = useCallback((job: Job) => {
    jobsEpoch.current += 1;
    setJobs(current => upsertCanvasJob(current, job));
  }, []);

  const reset = useCallback(() => {
    syncedTerminalRuns.current.clear();
    syncedCandidateVersionIds.current.clear();
  }, []);

  const hasRunningJobs = jobs.some(job => (
    job.namespace === 'canvas'
    && (job.status === 'pending' || job.status === 'pending_confirm')
  ));

  // 出图完成的通知走 SSE，轮询退成兜底。
  //
  // 画布 job 和角色 / Studio 的 job 在同一个 .runtime/jobs 目录下，watcher 早就在广播
  // job-changed 了，画布只是一直没订阅：以前最坏要等 1.2 秒才看见出图完成。
  // 轮询不能砍（#18 的教训，见 Studio 里那段注释）：系统代理的 TUN / 全局模式会把
  // 127.0.0.1 的流式响应整条缓冲，心跳也被憋住，浏览器永不 onerror、永不重连，SSE 成为
  // 唯一命脉时就是卡住不动。所以保留 pending 期间的定时全量拉取，只把间隔从 1.2s 放到 4s，
  // 与 Studio 一致。
  const requestJobSync = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!hasRunningJobs) {
      requestJobSync.current = () => undefined;
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const epoch = jobsEpoch.current;
        const canvasJobs = await listCanvasJobs(projectId);
        if (cancelled) return;
        const completedRuns = canvasJobs.filter(job => (
          job.canvas_run
          && job.status !== 'pending'
          && job.status !== 'pending_confirm'
          && !syncedTerminalRuns.current.has(job.canvas_run.run_id)
        ));
        const jobsWithNewCandidateVersions = canvasJobs.filter(job => (
          job.canvas_run?.candidates.some(candidate => (
            candidate.status === 'succeeded'
            && candidate.version_id
            && !syncedCandidateVersionIds.current.has(candidate.version_id)
          ))
        ));
        const newCandidateVersionIds = jobsWithNewCandidateVersions.flatMap(job => (
          job.canvas_run?.candidates.flatMap(candidate => (
            candidate.status === 'succeeded'
            && candidate.version_id
            && !syncedCandidateVersionIds.current.has(candidate.version_id)
              ? [candidate.version_id]
              : []
          )) ?? []
        ));
        const runIdsToSync = new Set([
          ...completedRuns.map(job => job.canvas_run!.run_id),
          ...jobsWithNewCandidateVersions.map(job => job.canvas_run!.run_id),
        ]);
        if (completedRuns.length || newCandidateVersionIds.length) {
          const remote = await getCanvasDocument(projectId);
          if (cancelled) return;
          // Multi-text slots keep their node IDs and have no active_run_id. Match
          // their new versions to the actual Job outputs, not unrelated idle nodes.
          const outputVersionIds = new Set(newCandidateVersionIds);
          // 图层栈节点没有 current_version_id，产物挂在 base_version_id / layers 上，
          // 只能按 result_node_id 认领；普通节点仍按新版本匹配，不动既有合并语义。
          const layerStackResultNodeIds = [...completedRuns, ...jobsWithNewCandidateVersions]
            .filter(job => job.params.layer_decomposition)
            .map(job => job.canvas_run!.result_node_id);
          const resultNodeIds = new Set([
            ...layerStackResultNodeIds,
            ...remote.nodes.flatMap(node => (
              'current_version_id' in node.data && outputVersionIds.has(node.data.current_version_id ?? '')
                ? [node.id] : []
            )),
          ]);
          mergeRunDocument(remote, runIdsToSync, resultNodeIds);
          for (const job of completedRuns) syncedTerminalRuns.current.add(job.canvas_run!.run_id);
          for (const versionId of newCandidateVersionIds) syncedCandidateVersionIds.current.add(versionId);
        }
        setJobs(current => (
          jobsEpoch.current === epoch ? canvasJobs : acceptCanvasJobs(current, canvasJobs)
        ));
      } catch (pollError) {
        if (!cancelled) onError((pollError as Error).message);
      }
    };
    // SSE 会成串地推（每写一个候选就是一次），这里合并：在跑就记一笔，跑完再补一次。
    let inFlight = false;
    let queued = false;
    const sync = async () => {
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        await poll();
      } finally {
        inFlight = false;
        if (queued && !cancelled) {
          queued = false;
          void sync();
        }
      }
    };
    requestJobSync.current = () => void sync();
    const timer = window.setInterval(() => void sync(), 4000);
    void sync();
    return () => {
      cancelled = true;
      requestJobSync.current = () => undefined;
      window.clearInterval(timer);
    };
  }, [hasRunningJobs, mergeRunDocument, onError, projectId]);

  const canvasJobIds = useMemo(
    () => new Set(jobs.filter(job => job.namespace === 'canvas').map(job => job.job_id)),
    [jobs],
  );

  // useSSE 每次 render 都把回调换到 ref 上，所以这里直接闭包捕获就是最新的一份。
  useSSE({
    // 只在有 job 在跑时建连：画布之外没有别的东西会改这个项目的 job，闲着时这条连接没有用处。
    enabled: hasRunningJobs,
    onJobChanged: data => {
      // job-changed 是全局广播，角色出图和 Studio 出图也会进来。认得的才拉。
      if (data.job_id && !canvasJobIds.has(data.job_id)) return;
      requestJobSync.current();
    },
    // 重连后全量补一次：断连期间 / 队列满丢掉的事件靠这一下补齐。
    onConnect: () => requestJobSync.current(),
  });

  return { jobs, acceptJobs, applyLocalJob, reset };
}
