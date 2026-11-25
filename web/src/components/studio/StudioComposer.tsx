import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { useLocation, useSearch } from 'wouter';
import { CanvasAgentModeMenu } from '@/components/agent/CanvasAgentModeMenu';
import { CanvasAgentModelPicker } from '@/components/agent/CanvasAgentModelPicker';
import { CanvasAgentPermissionMenu } from '@/components/agent/CanvasAgentPermissionMenu';
import { CanvasAgentPreferencePicker } from '@/components/agent/CanvasAgentPreferencePicker';
import { CanvasAgentSkillPicker } from '@/components/agent/CanvasAgentSkillPicker';
import { useWorkspaceAgent } from '@/components/agent/useWorkspaceAgent';
import { readStudioView, updateStudioView, type StudioInputMode } from '@/pages/studioDraft';
import { studioControlClass } from './ControlButton';
import { PromptInput } from './PromptInput';
import { Collapse } from '@/components/ui/collapse';
import { Button } from '@/components/ui/button';
import { ErrorIcon } from '@/components/ui/icons';
import { canvasAgentSetupNotice } from '@/components/agent/canvasAgentSetupNotice';

export function useStudioComposer(home = false) {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const link = home ? null : new URLSearchParams(search).get('session');
  const [mode, setMode] = useState<StudioInputMode>(() => readStudioView().inputMode);
  const agent = useWorkspaceAgent(null, !home || mode === 'agent', home, mode === 'agent', !home);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [skill, setSkill] = useState<string | null>(null);
  const messageId = useRef<string | null>(null);
  const sending = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  const selectSession = agent.selectSession;
  useEffect(() => {
    if (!link) return;
    void selectSession(link);
    const rest = new URLSearchParams(search);
    rest.delete('session');
    navigate(rest.size ? `${location}?${rest}` : location, { replace: true });
  }, [link, location, navigate, search, selectSession]);

  const switchMode = useCallback((next: StudioInputMode) => {
    setMode(next);
    updateStudioView({ inputMode: next });
  }, []);
  /** 发出去立刻清空输入、回到对话底部，消息先以「发送中」出现在对话里；失败时把这次的文字、附件、技能填回去
   *  （输入框里已经重新打了字就不覆盖）。幂等标识留到成功才换，失败重发仍是同一条。 */
  async function send(prompt: string) {
    if (sending.current) return;
    sending.current = true;
    const sentText = text;
    const sentFiles = files;
    const sentSkill = skill;
    try {
      messageId.current ??= crypto.randomUUID();
      setText('');
      setFiles([]);
      setSkill(null);
      // 记录区是 col-reverse，scrollTop 0 就是底部；回到底部不要滚动过程（飙哥指定）。
      document.querySelector<HTMLElement>('[data-studio-history-scroll]')?.scrollTo?.({ top: 0, behavior: 'auto' });
      const sent = await agent.sendStudio(prompt, sentFiles, [], sentSkill, messageId.current);
      if (!sent) {
        setText(current => current || sentText);
        setFiles(current => current.length ? current : sentFiles);
        setSkill(current => current ?? sentSkill);
        return;
      }
      messageId.current = null;
      if (home) navigate('/studio');
    } finally {
      sending.current = false;
    }
  }
  return { mode, switchMode, agent, text, setText, files, setFiles, skill, setSkill, editor, send };
}

export type StudioComposerState = ReturnType<typeof useStudioComposer>;

export function StudioComposer({ state, onOpenProviders, ...props }: {
  state: StudioComposerState;
  /** Agent 配置提示里的「去设置」。 */
  onOpenProviders?: () => void;
} & ComponentProps<typeof PromptInput>) {
  const { agent, skill, setSkill } = state;
  const settings = agent.session ?? agent.draft;
  const running = agent.session?.status === 'running';
  const busy = agent.pending || running || agent.session?.status === 'awaiting_approval';
  const creation = settings.creation_mode ?? 'all';
  const ready = agent.models?.models.some(item => item.model === settings.model && item.alias === settings.model_alias);
  const agentMode = state.mode === 'agent';
  // 与画布 Agent 面板同一条配置提示：发之前就说清楚缺什么、去哪补。
  const setupNotice = agentMode ? canvasAgentSetupNotice({
    chatModels: agent.models?.models ?? null,
    generationModels: agent.generationModels,
    mode: creation,
    auto: settings.auto_models ?? true,
    preferred: settings.preferred_models ?? [],
  }) : null;
  // 存的对话模型失效、但还有别的可用模型：静默换成第一个，不让发送按钮莫名置灰。
  const fallback = agentMode && agent.models && !ready && !busy ? agent.models.models[0] : undefined;
  const updateSettings = agent.updateSettings;
  const fallbackTried = useRef<string | null>(null);
  useEffect(() => {
    if (!fallback) return;
    const key = `${settings.model_alias ?? ''}/${settings.model ?? ''}`;
    if (fallbackTried.current === key) return;
    fallbackTried.current = key;
    void updateSettings({ model_alias: fallback.alias, model: fallback.model });
  }, [fallback, settings.model_alias, settings.model, updateSettings]);
  const triggerClassName = studioControlClass + ' shrink-0 w-auto';
  const controls = <>
    <CanvasAgentModelPicker triggerClassName={triggerClassName} models={agent.models} alias={settings.model_alias ?? null} model={settings.model ?? null}
            disabled={busy} onSelect={choice => void agent.updateSettings({ model_alias: choice.alias, model: choice.model })} />
    <CanvasAgentModeMenu triggerClassName={triggerClassName} mode={creation} disabled={busy} onSelect={creation_mode => void agent.updateSettings({ creation_mode })} />
    <CanvasAgentPreferencePicker triggerClassName={triggerClassName} models={agent.generationModels} mode={creation} auto={settings.auto_models ?? true}
            preferred={settings.preferred_models ?? []} disabled={busy} onChange={agent.updateSettings} />
    <CanvasAgentPermissionMenu triggerClassName={triggerClassName} auto={(settings.permission_mode ?? 'auto') === 'auto'} disabled={busy}
            confirmAbove={agent.confirmAbove} onModeChange={permission_mode => void agent.updateSettings({ permission_mode })}
            onConfirmAboveChange={agent.updateConfirmAbove} />
    <CanvasAgentSkillPicker triggerClassName={triggerClassName} label={skill ?? '技能'} skills={agent.skills} selected={skill}
            onSelect={name => setSkill(name === skill ? null : name)} disabled={busy} onChanged={agent.reloadSkills} />
  </>;
  const agentProps = state.mode === 'agent' ? {
    value: state.text, onValueChange: state.setText,
    referenceImages: state.files, onReferenceImagesChange: state.setFiles,
    onSubmit: state.send, onSavePromptAsset: undefined, estimateLabel: null,
    disabled: props.disabled || !ready || busy || agent.waitingForSession,
    onStop: running ? agent.stop : undefined, agentControls: controls,
    submitErrorKey: agent.error,
  } : {};
  // 报错行用 Collapse 从上沿展开，收起时保留最后一条文案播完退场。
  const lastError = useRef(agent.error);
  if (agent.error) lastError.current = agent.error;
  const lastNotice = useRef(setupNotice);
  if (setupNotice) lastNotice.current = setupNotice;
  const notice = setupNotice ?? lastNotice.current;
  return <div className="pointer-events-auto mx-auto w-full max-w-[780px]">
    <Collapse open={Boolean(agent.error)} appear>
      <p role={agent.error ? 'alert' : undefined} className="text-xs text-destructive">{agent.error ?? lastError.current}</p>
    </Collapse>
    <Collapse open={Boolean(setupNotice)} appear>
      {notice && <p role="status" className="mb-2 flex items-center gap-2 rounded-md border border-primary/30 bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
        <ErrorIcon size="sm" className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 break-words">{notice.text}</span>
        <Button variant="link" size="sm" type="button"
          onClick={() => notice.action === 'settings' ? onOpenProviders?.() : void agent.updateSettings({ auto_models: true })}
          className="h-auto shrink-0 p-0 text-xs text-primary"
        >{notice.action === 'settings' ? '去设置' : '改为自动'}</Button>
      </p>}
    </Collapse>
    <PromptInput {...props} {...agentProps} kind={state.mode} onKindChange={state.switchMode} inputRef={state.editor} />
  </div>;
}
