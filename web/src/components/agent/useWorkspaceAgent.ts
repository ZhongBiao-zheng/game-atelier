import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelCanvasAgentTurn,
  deleteCanvasAgentSession,
  sendStudioAgentMessage,
  uploadStudioAgentAttachment,
  createCanvasAgentSession,
  decideCanvasAgentApprovals,
  getCanvasAgentSession,
  getCanvasAgentPlan,
  getCanvasAgentSessionUsage,
  getCanvasAgentSettings,
  listCanvasAgentChatModels,
  listCanvasAgentGenerationModels,
  listCanvasAgentSessions,
  listCanvasAgentSkills,
  sendCanvasAgentMessage,
  updateCanvasAgentSession,
  updateCanvasAgentSettings,
} from '@/api/canvas';
import { readStudioView, updateStudioView } from '@/pages/studioDraft';
import { useSSE, type CanvasAgentEventPayload } from '@/hooks/useSSE';
import type {
  CanvasAgentChatModelList,
  CanvasAgentGenerationModel,
  CanvasAgentSession,
  StudioAgentSession,
  StudioAgentSessionSummary,
  CanvasAgentSessionUpdate,
  CanvasAgentPlan,
  CanvasAgentSessionUsage,
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

export function rememberedModel(): RememberedModel | null {
  try {
    const value = JSON.parse(readStorage(MODEL_STORAGE_KEY) ?? 'null') as RememberedModel | null;
    return value?.alias && value.model ? value : null;
  } catch { return null; }
}

/** 创作模式与模型偏好是用户偏好：跨会话、跨刷新记住，新对话默认用它。 */
const CREATION_STORAGE_KEY = 'canvas-agent-creation';
type RememberedCreation = Pick<CanvasAgentSessionUpdate, 'creation_mode' | 'auto_models' | 'preferred_models'>;

function rememberedCreation(): RememberedCreation {
  try {
    const value = JSON.parse(readStorage(CREATION_STORAGE_KEY) ?? 'null') as RememberedCreation | null;
    return {
      ...(value?.creation_mode ? { creation_mode: value.creation_mode } : {}),
      ...(typeof value?.auto_models === 'boolean' ? { auto_models: value.auto_models } : {}),
      ...(Array.isArray(value?.preferred_models) ? { preferred_models: value.preferred_models } : {}),
    };
  } catch { return {}; }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 新会话沿用的设置：模型、思考、权限、创作模式、模型偏好。 */
function carriedSettings(session: CanvasAgentSession | StudioAgentSession): CanvasAgentSessionUpdate {
  return {
    ...(session.model && session.model_alias
      ? { model: session.model, model_alias: session.model_alias } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    permission_mode: session.permission_mode,
    creation_mode: session.creation_mode,
    auto_models: session.auto_models,
    preferred_models: session.preferred_models,
  };
}

export function useWorkspaceAgent(projectId: string | null, open: boolean, home = false) {
  const [sessions, setSessions] = useState<StudioAgentSessionSummary[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [session, setSession] = useState<CanvasAgentSession | StudioAgentSession | null>(null);
  const [streaming, setStreaming] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [models, setModels] = useState<CanvasAgentChatModelList | null>(null);
  const [generationModels, setGenerationModels] = useState<CanvasAgentGenerationModel[] | null>(null);
  const [skills, setSkills] = useState<CanvasAgentSkill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [usage, setUsage] = useState<CanvasAgentSessionUsage | null>(null);
  const [plan, setPlan] = useState<CanvasAgentPlan | null>(null);
  const [confirmAbove, setConfirmAbove] = useState<number | null>(null);
  // 还没有会话时的设置：只记在本地，发第一条消息建会话时一并写入，不为选个模型就建空会话。
  const [draft, setDraft] = useState<CanvasAgentSessionUpdate>(() => {
    const model = rememberedModel();
    return { ...(model ? { model: model.model, model_alias: model.alias } : {}), ...rememberedCreation() };
  });
  // 「当前会话」以这个 ref 为准，只由选择 / 新建会话改写：不能每次 render 从 state 同步，
  // 否则读取途中任何一次重渲染都会把它冲回 null，读到的会话被当成过期结果丢掉。
  const sessionIdRef = useRef<string | null>(null);

  const acceptSession = useCallback((updated: CanvasAgentSession | StudioAgentSession) => {
    if (sessionIdRef.current !== updated.session_id) return;
    setSession(current => current?.session_id === updated.session_id && current.revision > updated.revision ? current : updated);
  }, []);

  const refreshList = useCallback(async () => {
    const list = await listCanvasAgentSessions(projectId);
    setSessions(list.sessions);
    return list.sessions;
  }, [projectId]);

  // 待办只用于显示：读不到不报错，保持上一次的。
  const loadPlan = useCallback((sessionId: string) => {
    getCanvasAgentPlan(projectId, sessionId).then(
      loaded => { if (sessionIdRef.current === sessionId) setPlan(loaded); },
      () => undefined,
    );
  }, [projectId]);

  const loadSession = useCallback(async (sessionId: string) => {
    const loaded = await getCanvasAgentSession(projectId, sessionId);
    if (sessionIdRef.current !== sessionId) return;  // 期间切到了别的会话
    acceptSession(loaded);
    if (loaded.status !== 'running') { setStreaming(''); setActiveTool(null); }
    // 用量只用于显示：读不到不报错，下次会话刷新再读。
    getCanvasAgentSessionUsage(projectId, sessionId).then(
      loadedUsage => { if (sessionIdRef.current === sessionId) setUsage(loadedUsage); },
      () => undefined,
    );
    loadPlan(sessionId);
  }, [acceptSession, loadPlan, projectId]);

  const selectSession = useCallback(async (sessionId: string) => {
    setError(null);
    setStreaming('');
    setUsage(null);
    setPlan(null);
    sessionIdRef.current = sessionId;
    setSession(null);
    setSelecting(true);
    if (projectId === null) updateStudioView({ activeSessionId: sessionId });
    else writeStorage(sessionStorageKey(projectId), sessionId);
    try {
      await loadSession(sessionId);
    } catch (loadError) {
      if (sessionIdRef.current === sessionId) setError(messageOf(loadError));
    } finally {
      if (sessionIdRef.current === sessionId) setSelecting(false);
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
        const last = projectId === null ? readStudioView().activeSessionId : readStorage(sessionStorageKey(projectId));
        if (projectId === null && home) return;
        const target = list.find(item => item.session_id === last) ?? (projectId === null ? undefined : list[0]);
        if (target) await selectSession(target.session_id);
      } catch (loadError) {
        if (!cancelled) setError(messageOf(loadError));
      }
    })();
    return () => { cancelled = true; };
  }, [home, open, projectId, refreshList, selectSession]);

  // 模型列表要实时拉各 Key 的 /models，只在首次打开时拉一次。
  useEffect(() => {
    if (!open || models) return;
    listCanvasAgentChatModels().then(setModels, loadError => setError(messageOf(loadError)));
  }, [open, models]);

  useEffect(() => {
    if (!open || generationModels) return;
    listCanvasAgentGenerationModels()
      .then(result => setGenerationModels(result.models), loadError => setError(messageOf(loadError)));
  }, [open, generationModels]);

  const reloadSkills = useCallback(() => {
    listCanvasAgentSkills().then(result => setSkills(result.skills), loadError => setError(messageOf(loadError)));
  }, []);
  useEffect(() => { if (open) reloadSkills(); }, [open, reloadSkills]);

  useEffect(() => {
    if (!open || confirmAbove !== null) return;
    getCanvasAgentSettings().then(
      settings => setConfirmAbove(settings.confirm_above_cny),
      loadError => setError(messageOf(loadError)),
    );
  }, [open, confirmAbove]);

  const onAgentEvent = (event: CanvasAgentEventPayload) => {
      if ((projectId !== null && event.project_id !== projectId) || !event.session_id) return;
      if (event.session_id !== sessionIdRef.current) return;
      if (event.kind === 'delta' && event.text) { setStreaming(current => current + event.text); setActiveTool(null); }
      if (event.kind === 'tool' && event.text) setActiveTool(event.text);
      if (event.kind === 'plan') loadPlan(event.session_id);
      if (event.kind === 'step' && event.step) {
        const step = event.step;
        setSession(current => {
          if (!current || !('turns' in current) || current.session_id !== event.session_id) return current;
          const turns = current.turns.map(turn => {
            if (turn.turn_id !== event.turn_id || turn.status !== 'running') return turn;
            const steps = new Map(turn.steps.map(item => [item.step_id, item]));
            steps.set(step.step_id, step);
            return { ...turn, steps: [...steps.values()] };
          });
          return { ...current, turns };
        });
      }
      if (event.kind === 'session') {
        void loadSession(event.session_id).catch(() => undefined);
        void refreshList().catch(() => undefined);
      }
    };
  useSSE({ enabled: open, onConnect: () => {
    if (projectId === null && sessionIdRef.current) void loadSession(sessionIdRef.current).catch(() => undefined);
  }, ...(projectId === null ? { onStudioAgent: onAgentEvent } : { onCanvasAgent: onAgentEvent }) });

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
  const createSession = useCallback(async () => {
    const settings: CanvasAgentSessionUpdate = session ? carriedSettings(session) : draft;
    let created = projectId === null ? await createCanvasAgentSession(null, '新对话', settings)
      : await createCanvasAgentSession(projectId, '新对话');
    if (projectId !== null && Object.keys(settings).length) {
      created = await updateCanvasAgentSession(projectId, created.session_id, settings);
    }
    sessionIdRef.current = created.session_id;
    if (projectId === null) updateStudioView({ activeSessionId: created.session_id });
    else writeStorage(sessionStorageKey(projectId), created.session_id);
    setSession(created);
    setStreaming('');
    await refreshList();
    return created;
  }, [draft, projectId, refreshList, session]);

  /** 新对话只清空面板，设置沿用当前会话；真正的会话在发第一条消息时才建。 */
  const newSession = useCallback(() => {
    if (session) setDraft(carriedSettings(session));
    if (projectId === null) updateStudioView({ activeSessionId: null });
    setSelecting(false);
    sessionIdRef.current = null;
    setSession(null);
    setUsage(null);
    setPlan(null);
    setStreaming('');
    setActiveTool(null);
    setError(null);
  }, [projectId, session]);

  const updateSettings = useCallback((update: CanvasAgentSessionUpdate) => {
    if (update.model && update.model_alias) {
      writeStorage(MODEL_STORAGE_KEY, JSON.stringify({ alias: update.model_alias, model: update.model }));
    }
    const creation: RememberedCreation = {
      ...(update.creation_mode ? { creation_mode: update.creation_mode } : {}),
      ...(update.auto_models !== undefined ? { auto_models: update.auto_models } : {}),
      ...(update.preferred_models ? { preferred_models: update.preferred_models } : {}),
    };
    if (Object.keys(creation).length) {
      writeStorage(CREATION_STORAGE_KEY, JSON.stringify({ ...rememberedCreation(), ...creation }));
    }
    if (!session) {
      setDraft(current => ({ ...current, ...update }));
      return Promise.resolve(undefined);
    }
    return run(async () => {
      const updated = await updateCanvasAgentSession(projectId, session.session_id, update);
      acceptSession(updated);
      return updated;
    });
  }, [acceptSession, projectId, run, session]);

  const send = useCallback((text: string, nodeIds: string[], skill: string | null) => run(async () => {
    const target = session ?? await createSession();
    setStreaming('');
    if (projectId === null) throw new Error('需要画布项目');
    const updated = await sendCanvasAgentMessage(projectId, target.session_id, {
      text, node_ids: nodeIds, ...(skill ? { skill } : {}),
    });
    acceptSession(updated);
    void refreshList().catch(() => undefined);
    return updated;
  }), [acceptSession, createSession, projectId, refreshList, run, session]);

  const sendStudio = (text: string, files: File[], assets: string[], skill: string | null, clientId: string) => run(async () => {
    const target = session ?? await createSession();
    const attachmentIds = await Promise.all(files.map(async file =>
      (await uploadStudioAgentAttachment(target.session_id, file)).attachment_id));
    setStreaming('');
    let updated: StudioAgentSession;
    try {
      updated = await sendStudioAgentMessage(target.session_id, { text, skill, asset_ids: assets,
        attachment_ids: attachmentIds, client_message_id: clientId });
    } catch (error) {
      // 连接断开时服务端可能已收件，以会话中的幂等标识确认结果。
      const saved = await getCanvasAgentSession(null, target.session_id).catch(() => null);
      if (!saved?.turns.some(turn => turn.client_message_id === clientId)) throw error;
      updated = saved;
    }
    acceptSession(updated);
    void refreshList().catch(() => undefined);
    return updated;
  });

  const removeSession = (id: string, revision: number) => run(async () => {
    await deleteCanvasAgentSession(projectId, id, revision);
    if (sessionIdRef.current === id) newSession();
    await refreshList();
  });

  /** approved：每个待确认调用是否执行；没列出的按拒绝。items：批量生成里勾选执行的项（没给就是全部）。 */
  const decide = useCallback((
    approved: ReadonlySet<string>,
    items: ReadonlyMap<string, readonly number[]> = new Map(),
  ) => run(async () => {
    if (!session) return undefined;
    setStreaming('');
    const decisions = session.pending_approvals.map(item => {
      const chosen = approved.has(item.call_id) ? items.get(item.call_id) : undefined;
      return { call_id: item.call_id, approve: approved.has(item.call_id), ...(chosen ? { items: [...chosen] } : {}) };
    });
    const updated = await decideCanvasAgentApprovals(projectId, session.session_id, decisions);
    acceptSession(updated);
    return updated;
  }), [acceptSession, projectId, run, session]);

  const stop = useCallback(() => run(async () => {
    if (!session) return undefined;
    const updated = await cancelCanvasAgentTurn(projectId, session.session_id);
    acceptSession(updated);
    setStreaming('');
    return updated;
  }), [acceptSession, projectId, run, session]);

  const updateConfirmAbove = useCallback((value: number) => run(async () => {
    const saved = await updateCanvasAgentSettings({ confirm_above_cny: value });
    setConfirmAbove(saved.confirm_above_cny);
    return saved;
  }), [run]);

  const clearError = useCallback(() => setError(null), []);

  return {
    sessions, session, draft, streaming, activeTool, models, generationModels, skills, error, pending: pending || selecting,
    usage, confirmAbove, plan,
    reloadSkills, sendStudio, removeSession,
    selectSession, newSession, updateSettings, send, decide, stop, updateConfirmAbove, clearError,
  };
}

export function useCanvasAgent(projectId: string, open: boolean) {
  return useWorkspaceAgent(projectId, open);
}
