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
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { OUTGOING_MESSAGE_PREFIX } from './canvasAgentTimeline';
import { DEFAULT_STUDIO_SESSION_ID, readStudioView, updateStudioView } from '@/pages/studioDraft';
import { useSSE, type CanvasAgentEventPayload } from '@/hooks/useSSE';
import type {
  CanvasAgentMessage,
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

interface OutgoingMessage {
  id: string;
  text: string;
  title: string | null;
  /** 创作台按幂等标识认领；画布没有，按会话版本号认领（版本变了就是服务端已经收下）。 */
  clientId: string | null;
  sessionId: string | null;
  revision: number | null;
}

/** 正在跑 / 刚跑完的工具：运行中显示「读取画布…」，下一段文字到达时原位换成「已读取画布」，不被清掉。 */
export interface AgentToolStatus {
  name: string;
  running: boolean;
}

/** 把发送中的消息并进会话：服务端还没收下时补一条用户消息（创作台另补一轮），收下后原样返回。 */
function withOutgoing<T extends CanvasAgentSession | StudioAgentSession>(session: T | null, outgoing: OutgoingMessage | null): T | null {
  if (!session || !outgoing || outgoing.sessionId !== session.session_id) return session;
  const message: CanvasAgentMessage = {
    role: 'user', title: outgoing.title, text: outgoing.text, reasoning_summary: null, references: [],
    turn_id: null, message_id: outgoing.id,
    sequence: (session.messages.at(-1)?.sequence ?? 0) + 1, created_at: new Date().toISOString(),
  };
  if ('turns' in session) {
    if (session.turns.some(turn => turn.client_message_id === outgoing.clientId)) return session;
    return {
      ...session,
      turns: [...session.turns, {
        turn_id: outgoing.id, client_message_id: outgoing.clientId ?? outgoing.id, status: 'running',
        attachment_ids: [], asset_ids: [], steps: [],
      }],
      messages: [...session.messages, { ...message, turn_id: outgoing.id }],
    };
  }
  if (session.revision !== outgoing.revision) return session;
  return { ...session, messages: [...session.messages, message] };
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

/** 跨页面共享的控件缓存：从首页切到创作台或重开面板时立刻展示，后台再静默刷新。测试环境不跨用例复用。 */
const CONTROLS_CACHE_ENABLED = import.meta.env.MODE !== 'test';
let cachedChatModels: CanvasAgentChatModelList | null = null;
let cachedGenerationModels: CanvasAgentGenerationModel[] | null = null;
let cachedSkills: CanvasAgentSkill[] | null = null;
let cachedConfirmAbove: number | null = null;

export function clearWorkspaceAgentControlsCache() {
  cachedChatModels = null;
  cachedGenerationModels = null;
  cachedSkills = null;
  cachedConfirmAbove = null;
}

export function useWorkspaceAgent(projectId: string | null, open: boolean, home = false, loadControls = open, sharedEvents = false) {
  const [sessions, setSessions] = useState<StudioAgentSessionSummary[]>([]);
  const [selecting, setSelecting] = useState(false);
  // 「加载中」与「为空」是两个状态：打开面板时先读上次停留的会话，读完之前不显示空对话。
  const [restoring, setRestoring] = useState(() => projectId === null
    ? !home && Boolean(readStudioView().activeSessionId)
    : open);
  const [session, setSession] = useState<CanvasAgentSession | StudioAgentSession | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingMessage | null>(null);
  const [streaming, setStreaming] = useState('');
  const [tool, setTool] = useState<AgentToolStatus | null>(null);
  const [models, setModels] = useState<CanvasAgentChatModelList | null>(() =>
    CONTROLS_CACHE_ENABLED && cachedChatModels ? { ...cachedChatModels, refresh_pending: true } : null);
  const [generationModels, setGenerationModels] = useState<CanvasAgentGenerationModel[] | null>(() => CONTROLS_CACHE_ENABLED ? cachedGenerationModels : null);
  const [skills, setSkills] = useState<CanvasAgentSkill[]>(() => CONTROLS_CACHE_ENABLED ? (cachedSkills ?? []) : []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 用量与待办按会话记：切会话时旧会话的内容留着显示，不会把旧会话的数挂到新会话上。
  const [usage, setUsage] = useState<{ sessionId: string; value: CanvasAgentSessionUsage } | null>(null);
  const [plan, setPlan] = useState<{ sessionId: string; value: CanvasAgentPlan | null } | null>(null);
  const [confirmAbove, setConfirmAbove] = useState<number | null>(() => CONTROLS_CACHE_ENABLED ? cachedConfirmAbove : null);
  // 还没有会话时的设置：只记在本地，发第一条消息建会话时一并写入，不为选个模型就建空会话。
  const [draft, setDraft] = useState<CanvasAgentSessionUpdate>(() => {
    const model = rememberedModel();
    return { ...(model ? { model: model.model, model_alias: model.alias } : {}), ...rememberedCreation() };
  });
  // 「当前会话」以这个 ref 为准，只由选择 / 新建会话改写：不能每次 render 从 state 同步，
  // 否则读取途中任何一次重渲染都会把它冲回 null，读到的会话被当成过期结果丢掉。
  const explicitDraft = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  // 实际显示的会话：切会话失败时退回到它，目标与它不一致期间不发送、不审批。
  const shownSessionIdRef = useRef<string | null>(null);
  useEffect(() => { shownSessionIdRef.current = session?.session_id ?? null; }, [session]);

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
      loaded => { if (sessionIdRef.current === sessionId) setPlan({ sessionId, value: loaded }); },
      () => undefined,
    );
  }, [projectId]);

  const loadSession = useCallback(async (sessionId: string) => {
    const loaded = await getCanvasAgentSession(projectId, sessionId);
    if (sessionIdRef.current !== sessionId) return;  // 期间切到了别的会话
    acceptSession(loaded);
    if (loaded.status !== 'running') { setStreaming(''); setTool(null); }
    // 用量只用于显示：读不到不报错，下次会话刷新再读。
    getCanvasAgentSessionUsage(projectId, sessionId).then(
      loadedUsage => { if (sessionIdRef.current === sessionId) setUsage({ sessionId, value: loadedUsage }); },
      () => undefined,
    );
    loadPlan(sessionId);
  }, [acceptSession, loadPlan, projectId]);

  // 切会话不先清空：旧会话留在原处（面板降透明度），新会话读到后整体替换。
  // 读到之后才记住选中的会话；读不到就整体退回仍在显示的那个，消息不会发进旧对话。
  const selectSession = useCallback(async (sessionId: string) => {
    setError(null);
    setStreaming('');
    setTool(null);
    sessionIdRef.current = sessionId;
    setSelecting(true);
    try {
      await loadSession(sessionId);
    } catch (loadError) {
      if (sessionIdRef.current !== sessionId) return;  // 期间又切到了别的会话，由那次收尾
      setError(messageOf(loadError));
      const shown = shownSessionIdRef.current;
      sessionIdRef.current = shown;
      setSelecting(false);
      setRestoring(false);
      // 选择期间旧会话的推送被挡掉了，退回后补读一次。
      if (shown) void loadSession(shown).catch(() => undefined);
      return;
    }
    if (sessionIdRef.current !== sessionId) return;
    if (projectId === null) updateStudioView({ activeSessionId: sessionId });
    else writeStorage(sessionStorageKey(projectId), sessionId);
    setSelecting(false);
    setRestoring(false);
  }, [loadSession, projectId]);

  // 打开面板：读会话列表，回到上次停留的会话。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await refreshList();
        if (cancelled || sessionIdRef.current || explicitDraft.current) return;
        const last = projectId === null ? readStudioView().activeSessionId : readStorage(sessionStorageKey(projectId));
        if (projectId === null && (home || last === null)) return;
        const target = list.find(item => item.session_id === last) ?? list[0];
        if (target) await selectSession(target.session_id);
        else {
          if (projectId === null) updateStudioView({ activeSessionId: null });
          setRestoring(false);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(messageOf(loadError));
          setRestoring(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [home, open, projectId, refreshList, selectSession]);

  // 每次打开或修改供应商都重新读取。仅在快照尚未完成探测时等一次最终结果。
  useEffect(() => {
    if (!loadControls) return;
    let generation = 0;
    function refresh() {
      const request = ++generation;
      const onError = (error: unknown) => { if (request === generation) setError(messageOf(error)); };
      void (async () => {
        let result = await listCanvasAgentChatModels();
        if (request !== generation) return;
        cachedChatModels = result;
        setModels(result);
        if (result.refresh_pending) {
          result = await listCanvasAgentChatModels(true);
          if (request !== generation) return;
          cachedChatModels = result;
          setModels(result);
        }
      })().catch(onError);
      listCanvasAgentGenerationModels().then(result => {
        if (request !== generation) return;
        cachedGenerationModels = result.models;
        setGenerationModels(result.models);
      }, onError);
    }
    refresh();
    window.addEventListener(KEYS_CHANGED_EVENT, refresh);
    return () => { generation++; window.removeEventListener(KEYS_CHANGED_EVENT, refresh); };
  }, [loadControls]);

  useEffect(() => {
    if (!loadControls) return;
    let active = true;
    getCanvasAgentSettings().then(settings => {
      if (!active) return;
      cachedConfirmAbove = settings.confirm_above_cny;
      setConfirmAbove(settings.confirm_above_cny);
    }, loadError => { if (active) setError(messageOf(loadError)); });
    return () => { active = false; };
  }, [loadControls]);

  const reloadSkills = useCallback(() => {
    listCanvasAgentSkills().then(result => {
      cachedSkills = result.skills;
      setSkills(result.skills);
    }, loadError => setError(messageOf(loadError)));
  }, []);
  useEffect(() => { if (loadControls) reloadSkills(); }, [loadControls, reloadSkills]);

  const onAgentEvent = (event: CanvasAgentEventPayload) => {
      if ((projectId !== null && event.project_id !== projectId) || !event.session_id) return;
      if (event.session_id !== sessionIdRef.current) {
        // 别的对话落盘（后台继续跑的旧对话结束了）：刷新列表，运行中圆点跟着变。
        if (event.kind === 'session') void refreshList().catch(() => undefined);
        return;
      }
      if (projectId === null && ['delta', 'tool'].includes(event.kind ?? '') &&
          (!session || !('turns' in session) || session.status !== 'running' || event.turn_id !== session.turns.at(-1)?.turn_id)) return;
      if (event.kind === 'delta' && event.text) {
        setStreaming(current => current + event.text);
        setTool(current => current?.running ? { ...current, running: false } : current);
      }
      if (event.kind === 'tool' && event.text) setTool({ name: event.text, running: true });
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
  const onReconnect = () => {
    if (projectId === null && sessionIdRef.current) void loadSession(sessionIdRef.current).catch(() => undefined);
  };
  useSSE({ enabled: open && !sharedEvents, onConnect: onReconnect,
    ...(projectId === null ? { onStudioAgent: onAgentEvent } : { onCanvasAgent: onAgentEvent }) });

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
  const createSession = useCallback(async (title = '新对话') => {
    const settings: CanvasAgentSessionUpdate = session ? carriedSettings(session) : draft;
    let created = projectId === null ? await createCanvasAgentSession(null, title, settings)
      : await createCanvasAgentSession(projectId, '新对话');
    if (projectId !== null && Object.keys(settings).length) {
      created = await updateCanvasAgentSession(projectId, created.session_id, settings);
    }
    sessionIdRef.current = created.session_id;
    if (projectId === null) updateStudioView({ activeSessionId: created.session_id });
    else writeStorage(sessionStorageKey(projectId), created.session_id);
    setSession(created);
    setStreaming('');
    void refreshList().catch(() => undefined);
    return created;
  }, [draft, projectId, refreshList, session]);

  /** 新对话只清空面板，设置沿用当前会话；真正的会话在发第一条消息时才建。 */
  const newSession = useCallback(() => {
    explicitDraft.current = true;
    if (session) setDraft(carriedSettings(session));
    if (projectId === null) updateStudioView({ activeSessionId: null });
    setRestoring(false);
    setSelecting(false);
    sessionIdRef.current = null;
    setSession(null);
    setUsage(null);
    setPlan(null);
    setStreaming('');
    setTool(null);
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

  // 切会话期间显示的还是旧会话：这时发出去会发进旧会话，等新会话读到再发。
  // 目标会话与显示的会话不一致（读取中或读取失败尚未退回）时同样拦住发送与审批。
  const waitingForSession = restoring || selecting || sessionIdRef.current !== (session?.session_id ?? null);
  const rejectWaiting = useCallback(() => run(() => Promise.reject(new Error('请先载入对话或选择新对话'))), [run]);

  /** 发送时先把消息显示成「发送中」，服务端确认后换成正式的那条；失败撤掉，由调用方把文字填回输入框。 */
  const sendOptimistic = useCallback(<T,>(
    text: string,
    title: string | null,
    clientId: string | null,
    action: (claim: (target: CanvasAgentSession | StudioAgentSession) => void) => Promise<T>,
  ) => {
    const id = OUTGOING_MESSAGE_PREFIX + (clientId ?? crypto.randomUUID());
    setOutgoing({ id, text, title, clientId, sessionId: session?.session_id ?? null, revision: session?.revision ?? null });
    const claim = (target: CanvasAgentSession | StudioAgentSession) => setOutgoing(current => current?.id === id
      ? { ...current, sessionId: target.session_id, revision: target.revision } : current);
    return run(async () => {
      try {
        return await action(claim);
      } finally {
        setOutgoing(current => current?.id === id ? null : current);
      }
    });
  }, [run, session]);

  const send = useCallback((text: string, nodeIds: string[], skill: string | null) => waitingForSession
    ? rejectWaiting()
    : sendOptimistic(text, skill, null, async claim => {
    const target = session ?? await createSession();
    claim(target);
    setStreaming('');
    if (projectId === null) throw new Error('需要画布项目');
    const updated = await sendCanvasAgentMessage(projectId, target.session_id, {
      text, node_ids: nodeIds, ...(skill ? { skill } : {}),
    });
    acceptSession(updated);
    void refreshList().catch(() => undefined);
    return updated;
  }), [acceptSession, createSession, projectId, refreshList, rejectWaiting, sendOptimistic, session, waitingForSession]);

  const sendStudio = (text: string, files: File[], assets: string[], skill: string | null, clientId: string) => waitingForSession
    ? rejectWaiting()
    : sendOptimistic(text, skill, clientId, async claim => {
    const target = session ?? await createSession();
    claim(target);
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

  /** 重命名对话（支持当前对话或列表中任意已有对话，不阻塞运行中的轮次）。 */
  const renameSession = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    const updated = await updateCanvasAgentSession(projectId, id, { title: trimmed });
    acceptSession(updated);
    setSessions(current => current.map(item => item.session_id === id
      ? { ...item, title: updated.title, revision: updated.revision } : item));
    return updated;
  }, [acceptSession, projectId]);

  /** 删除对话；返回回收站条目 id（没进回收站时为 null），调用方用它发撤销 toast。 */
  const removeSession = (id: string, revision: number) => run(async () => {
    const trashId = await deleteCanvasAgentSession(projectId, id, revision);
    if (sessionIdRef.current === id) {
      if (projectId === null) await selectSession(DEFAULT_STUDIO_SESSION_ID);
      else newSession();
    }
    await refreshList();
    return trashId;
  });

  /** approved：每个待确认调用是否执行；没列出的按拒绝。items：批量生成里勾选执行的项（没给就是全部）。 */
  const decide = useCallback((
    approved: ReadonlySet<string>,
    items: ReadonlyMap<string, readonly number[]> = new Map(),
  ) => waitingForSession ? rejectWaiting() : run(async () => {
    if (!session) return undefined;
    setStreaming('');
    const decisions = session.pending_approvals.map(item => {
      const chosen = approved.has(item.call_id) ? items.get(item.call_id) : undefined;
      return { call_id: item.call_id, approve: approved.has(item.call_id), ...(chosen ? { items: [...chosen] } : {}) };
    });
    const updated = await decideCanvasAgentApprovals(projectId, session.session_id, decisions);
    acceptSession(updated);
    return updated;
  }), [acceptSession, projectId, rejectWaiting, run, session, waitingForSession]);

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

  const displayedSession = withOutgoing(session, outgoing);
  return {
    sessions, session: displayedSession, draft, streaming, tool, models, generationModels, skills, error, pending: pending || selecting,
    usage: usage && usage.sessionId === session?.session_id ? usage.value : null,
    plan: plan && plan.sessionId === session?.session_id ? plan.value : null,
    confirmAbove,
    /** 正在读会话（打开面板时恢复上次的、或切到另一个会话）：期间显示的仍是旧内容，不是空对话。 */
    loading: restoring || selecting,
    /** 发送中、服务端还没收下的消息（还没有会话时，面板直接显示它）。 */
    outgoing: outgoing && (!session || outgoing.sessionId !== session.session_id) ? outgoing : null,
    // 切会话期间旧会话还在显示，创作台按它过滤记录，等新会话读到再一起换。
    selectedSessionId: (selecting ? session?.session_id : null) ?? sessionIdRef.current
      ?? (projectId === null && restoring ? readStudioView().activeSessionId : null),
    onAgentEvent, onReconnect, createSession, reloadSkills, sendStudio, renameSession, removeSession, waitingForSession,
    refreshSessions: refreshList,
    selectSession, newSession, updateSettings, send, decide, stop, updateConfirmAbove, clearError,
  };
}

export function useCanvasAgent(projectId: string, open: boolean) {
  return useWorkspaceAgent(projectId, open);
}
