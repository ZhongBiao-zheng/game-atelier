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
  function clearDraft() {
    setText('');
    setFiles([]);
    setSkill(null);
    messageId.current = null;
  }
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
  return { mode, switchMode, agent, text, setText, files, setFiles, skill, setSkill, clearDraft, editor, send };
}

export type StudioComposerState = ReturnType<typeof useStudioComposer>;

export function StudioComposer({ state, ...props }: { state: StudioComposerState } & ComponentProps<typeof PromptInput>) {
  const { agent, skill, setSkill } = state;
  const settings = agent.session ?? agent.draft;
  const running = agent.session?.status === 'running';
  const busy = agent.pending || running || agent.session?.status === 'awaiting_approval';
  const creation = settings.creation_mode ?? 'all';
  const ready = agent.models?.models.some(item => item.model === settings.model && item.alias === settings.model_alias);
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
    onSubmit: state.send, onSavePromptAsset: undefined, disabled: props.disabled || !ready || busy || agent.waitingForSession,
    onStop: running ? agent.stop : undefined, agentControls: controls,
  } : {};
  return <div className="pointer-events-auto mx-auto w-full max-w-[780px]">
    {agent.error && <p role="alert" className="text-xs text-destructive">{agent.error}</p>}
    <PromptInput {...props} {...agentProps} kind={state.mode} onKindChange={state.switchMode} inputRef={state.editor} />
  </div>;
}
