import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelCanvasAgentTurn,
  createCanvasAgentSession,
  decideCanvasAgentApprovals,
  getCanvasAgentSession,
  listCanvasAgentChatModels,
  listCanvasAgentSessions,
  listCanvasAgentSkills,
  sendCanvasAgentMessage,
  updateCanvasAgentSession,
} from '@/api/canvas';
import { useSSE, type CanvasAgentEventPayload } from '@/hooks/useSSE';
import type {
  CanvasAgentChatModelList,
  CanvasAgentSession,
  CanvasAgentSessionSummary,
  CanvasAgentSessionUpdate,
  CanvasAgentSkill,
} from '@/schema/canvas';

/** SSE 可能被本机代理整条憋住：运行中再按这个间隔拉一次会话兜底。 */
const RUNNING_POLL_MS = 3000;
const MODEL_STORAGE_KEY = 'canvas-agent-model';
const sessionStorageKey = (projectId: string) => `canvas-agent-session:${projectId}`;

interface RememberedModel { alias: string; model: string }

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* 无痕模式等：只是下次不记得 */ }
}

function rememberedModel(): RememberedModel | null {
  try {
    const value = JSON.parse(readStorage(MODEL_STORAGE_KEY) ?? 'null') as RememberedModel | null;
    return value?.alias && value.model ? value : null;
  } catch { return null; }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useCanvasAgent(projectId: string, open: boolean) {
  const [sessions, setSessions] = useState<CanvasAgentSessionSummary[]>([]);
  const [session, setSession] = useState<CanvasAgentSession | null>(null);
  const [streaming, setStreaming] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [models, setModels] = useState<CanvasAgentChatModelList | null>(null);
  const [skills, setSkills] = useState<CanvasAgentSkill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 还没有会话时的设置：只记在本地，发第一条消息建会话时一并写入，不为选个模型就建空会话。
  const [draft, setDraft] = useState<CanvasAgentSessionUpdate>(() => {
    const model = rememberedModel();
    return model ? { model: model.model, model_alias: model.alias } : {};
  });
  // 「当前会话」以这个 ref 为准，只由选择 / 新建会话改写：不能每次 render 从 state 同步，
  // 否则读取途中任何一次重渲染都会把它冲回 null，读到的会话被当成过期结果丢掉。
  const sessionIdRef = useRef<string | null>(null);

  const refreshList = useCallback(async () => {
    const list = await listCanvasAgentSessions(projectId);
    setSessions(list.sessions);
    return list.sessions;
  }, [projectId]);

  const loadSession = useCallback(async (sessionId: string) => {
    const loaded = await getCanvasAgentSession(projectId, sessionId);
    if (sessionIdRef.current !== sessionId) return;  // 期间切到了别的会话
    setSession(loaded);
    if (loaded.status !== 'running') { setStreaming(''); setActiveTool(null); }
  }, [projectId]);

  const selectSession = useCallback(async (sessionId: string) => {
    setError(null);
    setStreaming('');
    sessionIdRef.current = sessionId;
    writeStorage(sessionStorageKey(projectId), sessionId);
    try {
      await loadSession(sessionId);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, [loadSession, projectId]);

  // 打开面板：读会话列表，回到上次停留的会话。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await refreshList();
        if (cancelled || sessionIdRef.current) return;
        const last = readStorage(sessionStorageKey(projectId));
        const target = list.find(item => item.session_id === last) ?? list[0];
        if (target) await selectSession(target.session_id);
      } catch (loadError) {
        if (!cancelled) setError(messageOf(loadError));
      }
    })();
    return () => { cancelled = true; };
  }, [open, projectId, refreshList, selectSession]);

  // 模型列表要实时拉各 Key 的 /models，只在首次打开时拉一次。
  useEffect(() => {
    if (!open || models) return;
    listCanvasAgentChatModels().then(setModels, loadError => setError(messageOf(loadError)));
  }, [open, models]);

  const reloadSkills = useCallback(() => {
    listCanvasAgentSkills().then(result => setSkills(result.skills), loadError => setError(messageOf(loadError)));
  }, []);
  useEffect(() => { if (open) reloadSkills(); }, [open, reloadSkills]);

  useSSE({
    enabled: open,
    onCanvasAgent: (event: CanvasAgentEventPayload) => {
      if (event.project_id !== projectId || !event.session_id) return;
      if (event.session_id !== sessionIdRef.current) return;
      if (event.kind === 'delta' && event.text) { setStreaming(current => current + event.text); setActiveTool(null); }
      if (event.kind === 'tool' && event.text) setActiveTool(event.text);
      if (event.kind === 'session') {
        void loadSession(event.session_id).catch(() => undefined);
        void refreshList().catch(() => undefined);
      }
    },
  });

  const runningSessionId = session?.status === 'running' ? session.session_id : null;
  useEffect(() => {
    if (!open || !runningSessionId) return;
    const timer = window.setInterval(() => {
      void loadSession(runningSessionId).catch(() => undefined);
    }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, runningSessionId, loadSession]);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setPending(true);
    try {
      return await action();
    } catch (actionError) {
      setError(messageOf(actionError));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  /** 新会话沿用当前会话的模型 / 思考 / 权限；没有当前会话时用上次选过的模型。 */
  const createSession = useCallback(async (): Promise<CanvasAgentSession> => {
    let created = await createCanvasAgentSession(projectId, '新对话');
    const settings: CanvasAgentSessionUpdate = session
      ? {
        ...(session.model && session.model_alias
          ? { model: session.model, model_alias: session.model_alias } : {}),
        ...(session.effort ? { effort: session.effort } : {}),
        permission_mode: session.permission_mode,
      }
      : draft;
    if (Object.keys(settings).length) {
      created = await updateCanvasAgentSession(projectId, created.session_id, settings);
    }
    sessionIdRef.current = created.session_id;
    writeStorage(sessionStorageKey(projectId), created.session_id);
    setSession(created);
    setStreaming('');
    await refreshList();
    return created;
  }, [draft, projectId, refreshList, session]);

  /** 新对话只清空面板，设置沿用当前会话；真正的会话在发第一条消息时才建。 */
  const newSession = useCallback(() => {
    if (session) {
      setDraft({
        ...(session.model && session.model_alias
          ? { model: session.model, model_alias: session.model_alias } : {}),
        ...(session.effort ? { effort: session.effort } : {}),
        permission_mode: session.permission_mode,
      });
    }
    sessionIdRef.current = null;
    setSession(null);
    setStreaming('');
    setActiveTool(null);
    setError(null);
  }, [session]);

  const updateSettings = useCallback((update: CanvasAgentSessionUpdate) => {
    if (update.model && update.model_alias) {
      writeStorage(MODEL_STORAGE_KEY, JSON.stringify({ alias: update.model_alias, model: update.model }));
    }
    if (!session) {
      setDraft(current => ({ ...current, ...update }));
      return Promise.resolve(undefined);
    }
    return run(async () => {
      const updated = await updateCanvasAgentSession(projectId, session.session_id, update);
      setSession(updated);
      return updated;
    });
  }, [projectId, run, session]);

  const send = useCallback((text: string, nodeIds: string[], skill: string | null) => run(async () => {
    const target = session ?? await createSession();
    setStreaming('');
    const updated = await sendCanvasAgentMessage(projectId, target.session_id, {
      text, node_ids: nodeIds, ...(skill ? { skill } : {}),
    });
    setSession(updated);
    void refreshList().catch(() => undefined);
    return updated;
  }), [createSession, projectId, refreshList, run, session]);

  const decide = useCallback((approve: boolean) => run(async () => {
    if (!session) return undefined;
    setStreaming('');
    const decisions = session.pending_approvals.map(item => ({ call_id: item.call_id, approve }));
    const updated = await decideCanvasAgentApprovals(projectId, session.session_id, decisions);
    setSession(updated);
    return updated;
  }), [projectId, run, session]);

  const stop = useCallback(() => run(async () => {
    if (!session) return undefined;
    const updated = await cancelCanvasAgentTurn(projectId, session.session_id);
    setSession(updated);
    setStreaming('');
    return updated;
  }), [projectId, run, session]);

  const clearError = useCallback(() => setError(null), []);

  return {
    sessions, session, draft, streaming, activeTool, models, skills, error, pending, reloadSkills,
    selectSession, newSession, updateSettings, send, decide, stop, clearError,
  };
}

export type CanvasAgentController = ReturnType<typeof useCanvasAgent>;
