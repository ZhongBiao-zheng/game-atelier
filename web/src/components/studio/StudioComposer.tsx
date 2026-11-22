import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import { listCreationAssets } from '@/api/creationAssets';
import { CanvasAgentModeMenu } from '@/components/agent/CanvasAgentModeMenu';
import { CanvasAgentModelPicker } from '@/components/agent/CanvasAgentModelPicker';
import { CanvasAgentPermissionMenu } from '@/components/agent/CanvasAgentPermissionMenu';
import { CanvasAgentPreferencePicker } from '@/components/agent/CanvasAgentPreferencePicker';
import { CanvasAgentSkillPicker } from '@/components/agent/CanvasAgentSkillPicker';
import { useWorkspaceAgent } from '@/components/agent/useWorkspaceAgent';
import { Button } from '@/components/ui/button';
import { FileInput } from '@/components/ui/file-input';
import { AddImageIcon, ArrowUpIcon, CloseIcon, ParamsIcon, StopIcon } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { canonicalMentionLabel } from '@/lib/mentionTokens';
import { readStudioView, updateStudioView, type StudioMode } from '@/pages/studioDraft';
import { assetMediaContent, type CreationAsset } from '@/schema/creationAssets';

export function useStudioComposer(home = false) {
  const search = useSearch();
  const query = new URLSearchParams(search);
  const link = home ? null : query.get('session');
  const [mode, setMode] = useState<StudioMode>(() => home || query.has('job') ? 'creation' : link ? 'agent' : readStudioView().mode);
  const agent = useWorkspaceAgent(null, mode === 'agent', home);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [skill, setSkill] = useState<string | null>(null);
  const messageId = useRef<string | null>(null);
  const openedLink = useRef<string | null>(null);
  const selectSession = agent.selectSession;
  useEffect(() => {
    if (!link || link === openedLink.current) return;
    openedLink.current = link;
    setMode('agent');
    updateStudioView({ mode: 'agent', activeSessionId: link });
    void selectSession(link);
  }, [link, selectSession]);
  function switchMode(next: StudioMode) {
    setMode(next);
    updateStudioView({ mode: next });
  }
  function clearDraft() {
    setText(''); setFiles([]); setAssets([]); setSkill(null); messageId.current = null;
  }
  return { home, mode, switchMode, clearDraft, agent,
    input: { text, setText, files, setFiles, assets, setAssets, skill, setSkill, messageId } };

}

export type StudioComposerState = ReturnType<typeof useStudioComposer>;

function ImageTile({ file, remove }: { file: File; remove: () => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return <Button variant="ghost" size="icon" type="button" aria-label={`移除 ${file.name}`} onClick={remove}
    className="group relative size-14 shrink-0 overflow-hidden rounded-lg">
    {url && <img src={url} alt={file.name} className="size-full object-cover" />}
    <CloseIcon size="sm" className="absolute right-0 top-0 rounded-full bg-card opacity-0 group-hover:opacity-100" />
  </Button>;
}

function AgentInput({ state }: { state: StudioComposerState }) {
  const { agent, home } = state;
  const [, navigate] = useLocation();
  const { text, setText, files, setFiles, assets, setAssets, skill, setSkill, messageId } = state.input;
  const [library, setLibrary] = useState<CreationAsset[]>([]);
  const [libraryError, setLibraryError] = useState('');
  const [mention, setMention] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const settings = agent.session ?? agent.draft;
  const running = agent.session?.status === 'running';
  const busy = agent.pending || running || agent.session?.status === 'awaiting_approval';
  const creation = settings.creation_mode ?? 'all';
  const ready = settings.model && settings.model_alias && agent.models?.models.some(
    m => m.model === settings.model && m.alias === settings.model_alias);
  const canSend = !busy && ready && Boolean(text.trim() || files.length || assets.length);

  useEffect(() => {
    if (!mention) return;
    let active = true;
    setLibraryError('');
    listCreationAssets({ scope: 'all' }).then(result => { if (active) setLibrary(result.assets); },
      error => { if (active) setLibraryError(String(error)); });
    return () => { active = false; };
  }, [mention]);

  async function send() {
    if (!canSend || sending.current) return;
    sending.current = true;
    try {
      messageId.current ??= crypto.randomUUID();
      const sent = await agent.sendStudio(text.trim(), files, assets.map(a => a.asset_id), skill, messageId.current);
      if (!sent) return;
      state.clearDraft();
      if (home) {
        updateStudioView({ mode: 'agent', activeSessionId: sent.session_id });
        navigate('/studio');
      }
    } finally { sending.current = false; }
  }

  function chooseAsset(asset: CreationAsset) {
    const picked = assets.some(item => item.asset_id === asset.asset_id) ? assets : [...assets, asset];
    if (picked.length > 16) return;
    const media = assetMediaContent(asset)?.mime_type.split('/')[0];
    const kind = ({ image: '图', video: '视频', audio: '音频' } as Record<string, string>)[media ?? ''];
    const index = picked.filter(item => assetMediaContent(item)?.mime_type.split('/')[0] === media)
      .findIndex(item => item.asset_id === asset.asset_id) + 1;
    const token = kind ? canonicalMentionLabel(kind, String(index)) : asset.title;
    setAssets(picked);
    setText(current => current.replace(/@[^\s@]*$/, '').trimEnd() + ' @' + token + ' ');
    setMention(false);
    textarea.current?.focus();
  }

  return <div className="bg-glass shell-glow relative z-20 rounded-xl border border-input px-4 py-3 backdrop-blur-glass">
    <div className="flex items-start gap-3">
      <Button variant="outline" size="icon" type="button" aria-label="上传参考图" onClick={() => fileInput.current?.click()}
        disabled={busy || files.length >= 16}
        className="grid size-14 shrink-0 place-items-center rounded-lg border border-dashed border-input text-muted-foreground hover:bg-secondary">
        <AddImageIcon />
      </Button>
      <FileInput ref={fileInput} aria-label="选择参考图" multiple accept="image/*" onChange={event => {
        const next = Array.from(event.target.files ?? []);
        setFiles(current => [...current, ...next].slice(0, 16)); event.target.value = '';
      }} />
      <div className="min-w-0 flex-1">
        {!!files.length && <div className="mb-2 flex flex-wrap gap-1">{files.map((file, i) =>
          <ImageTile key={i} file={file} remove={() => setFiles(current => current.filter((_, n) => n !== i))} />)}</div>}
        <Textarea ref={textarea} rows={2} value={text}
          placeholder="输入想法或上传参考，和 Agent 一起创作"
          className="min-h-16 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none placeholder:text-muted-foreground"
          onChange={event => { setText(event.target.value); if (event.target.value.endsWith('@')) setMention(true); }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); void send();
            }
          }} />
      </div>
    </div>
    {!!assets.length && <div className="flex flex-wrap gap-1">{assets.map(asset =>
      <Button key={asset.asset_id} variant="secondary" size="sm"
        aria-label={`移除引用 ${asset.title}`} onClick={() => setAssets(current => current.filter(a => a !== asset))}>
        {asset.title}<CloseIcon size="sm" /></Button>)}</div>}
    {(agent.error || libraryError) && <p role="alert" className="mt-2 text-xs text-destructive">{agent.error || libraryError}</p>}
    {settingsOpen && <div aria-label="创作设置" className="flex flex-wrap items-center gap-1 border-b border-border py-2">
      <CanvasAgentModeMenu mode={creation} disabled={busy} onSelect={creation_mode => void agent.updateSettings({ creation_mode })} />
      <CanvasAgentPreferencePicker models={agent.generationModels} mode={creation} auto={settings.auto_models ?? true}
        preferred={settings.preferred_models ?? []} disabled={busy} onChange={agent.updateSettings} />
      <CanvasAgentPermissionMenu auto={(settings.permission_mode ?? 'auto') === 'auto'} disabled={busy}
        confirmAbove={agent.confirmAbove} onModeChange={permission_mode => void agent.updateSettings({ permission_mode })}
        onConfirmAboveChange={agent.updateConfirmAbove} />
    </div>}
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <Button size="sm" variant="ghost" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>
        <ParamsIcon size="sm" />创作设置</Button>
      <CanvasAgentSkillPicker label={skill ?? '技能'} skills={agent.skills} selected={skill}
        onSelect={name => setSkill(name === skill ? null : name)} disabled={busy} onChanged={agent.reloadSkills} />
      <Popover open={mention} onOpenChange={setMention}><PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="引用资产">@</Button>
      </PopoverTrigger><PopoverContent align="start" className="max-h-64 overflow-auto p-1">
        {library.map(asset => <Button key={asset.asset_id} size="sm" variant="ghost" className="w-full justify-start"
          onClick={() => chooseAsset(asset)}>{asset.title}</Button>)}
        {!library.length && <p className="p-2 text-xs text-muted-foreground">暂无可引用资产</p>}
      </PopoverContent></Popover>
      <div className="ml-auto flex items-center gap-2">
        <CanvasAgentModelPicker models={agent.models} alias={settings.model_alias ?? null} model={settings.model ?? null}
          disabled={busy} onSelect={choice => void agent.updateSettings({ model_alias: choice.alias, model: choice.model })} />
        <Button type="button" size="icon" className="rounded-full" aria-label={running ? '停止' : '发送'}
          disabled={running ? agent.pending : !canSend} onClick={() => running ? void agent.stop() : void send()}>
          {running ? <StopIcon /> : <ArrowUpIcon />}
        </Button>
      </div>
    </div>
  </div>;
}

export function StudioComposer({ state, children }: { state: StudioComposerState; children: ReactNode }) {
  return <div className="pointer-events-auto mx-auto w-full max-w-[780px]">
    {state.mode === 'creation' ? children : <AgentInput state={state} />}
    <div className="relative -mt-3 rounded-b-xl border border-t-0 border-input bg-panel px-3 pb-1.5 pt-4">
      <Segmented aria-label="输入模式" className="inline-grid grid-cols-2">
        <SegmentedItem value="creation" selected={state.mode === 'creation'} onSelect={() => state.switchMode('creation')} className="h-7 px-3 text-xs">创作</SegmentedItem>
        <SegmentedItem value="agent" selected={state.mode === 'agent'} onSelect={() => state.switchMode('agent')} className="h-7 px-3 text-xs">Agent</SegmentedItem>
      </Segmented>
    </div>
  </div>;
}
