import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useLocation, useSearch } from 'wouter';
import { listCreationAssets } from '@/api/creationAssets';
import { CanvasAgentModeMenu } from '@/components/agent/CanvasAgentModeMenu';
import { CanvasAgentModelPicker } from '@/components/agent/CanvasAgentModelPicker';
import { CanvasAgentPermissionMenu } from '@/components/agent/CanvasAgentPermissionMenu';
import { CanvasAgentPreferencePicker } from '@/components/agent/CanvasAgentPreferencePicker';
import { CanvasAgentSkillPicker } from '@/components/agent/CanvasAgentSkillPicker';
import { useWorkspaceAgent } from '@/components/agent/useWorkspaceAgent';
import { Lightbox } from '@/components/Lightbox';
import { Button } from '@/components/ui/button';
import { FileInput } from '@/components/ui/file-input';
import { AddIcon, ArrowUpIcon, CloseIcon, CollapseIcon, ExpandIcon, StopIcon } from '@/components/ui/icons';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { renumberMentions, serializeMentions } from './PromptInput';
import { canonicalMentionLabel, createMentionTokenRegex, mentionLabelForKind, type MentionKind } from '@/lib/mentionTokens';
import { readStudioView, updateStudioView, type StudioMode } from '@/pages/studioDraft';
import { assetMediaContent, type CreationAsset } from '@/schema/creationAssets';

const REF_W = 48;
const REF_H = 60;
const REF_STEP = 42;
const COLLAPSE_ANGLES = [8, -4, 22, -8, 8, -4];
const collapseAngle = (i: number) => COLLAPSE_ANGLES[i % COLLAPSE_ANGLES.length];
const REF_HOVER_SCALE = 1.04;
const REF_HOVER_LIFT = -5;

export function useStudioComposer(home = false) {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const query = new URLSearchParams(search);
  const link = home ? null : query.get('session');
  const [mode, setMode] = useState<StudioMode>(() => home || query.has('job') ? 'creation' : link ? 'agent' : readStudioView().mode);
  const agent = useWorkspaceAgent(null, mode === 'agent', home);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [assets, setAssets] = useState<CreationAsset[]>([]);
  const [skill, setSkill] = useState<string | null>(null);
  const [mention, setMention] = useState(false);
  const [library, setLibrary] = useState<CreationAsset[]>([]);
  const [libraryError, setLibraryError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const caret = useRef(0);
  const restoreCaret = useRef<number | null>(null);
  const messageId = useRef<string | null>(null);
  const openedLink = useRef<string | null>(null);
  const selectSession = agent.selectSession;
  useEffect(() => {
    if (!link || link === openedLink.current) return;
    openedLink.current = link;
    setMode('agent');
    updateStudioView({ mode: 'agent', activeSessionId: link });
    void selectSession(link);
    const rest = new URLSearchParams(search);
    rest.delete('session');
    navigate(rest.size ? `${location}?${rest}` : location, { replace: true });
  }, [link, location, navigate, search, selectSession]);
  useEffect(() => {
    if (!mention) return;
    let active = true;
    setLibraryError('');
    listCreationAssets({ scope: 'all' }).then(result => { if (active) setLibrary(result.assets); },
      error => { if (active) setLibraryError(String(error)); });
    return () => { active = false; };
  }, [mention]);
  function switchMode(next: StudioMode) {
    setMode(next);
    updateStudioView({ mode: next });
  }
  function clearDraft() {
    setText(''); setFiles([]); setAssets([]); setSkill(null); messageId.current = null;
  }
  function mentionFor(asset: CreationAsset, items: CreationAsset[]) {
    const media = assetMediaContent(asset)?.mime_type.split('/')[0] as MentionKind | undefined;
    if (!media) return { label: asset.title, index: 0, token: asset.title };
    const index = (media === 'image' ? files.length : 0) + 1 + items.filter(item =>
      assetMediaContent(item)?.mime_type.split('/')[0] === media).findIndex(item => item.asset_id === asset.asset_id);
    const label = mentionLabelForKind(media);
    return { label, index, token: canonicalMentionLabel(label, index) };
  }
  function chooseAsset(asset: CreationAsset) {
    const picked = assets.some(item => item.asset_id === asset.asset_id) ? assets : [...assets, asset];
    if (picked.length > 16) return;
    const { token } = mentionFor(asset, picked);
    const before = text.slice(0, caret.current).replace(/@[^\s@]*$/, '');
    const after = text.slice(caret.current);
    const insert = (before && !/\s$/.test(before) ? ' @' : '@') + token + ' ';
    setText(before + insert + after);
    setAssets(picked);
    setMention(false);
    restoreCaret.current = (before + insert).length;
  }
  function removeAsset(asset: CreationAsset) {
    const { label, index } = mentionFor(asset, assets);
    setText(current => index ? renumberMentions(current, label, index) : current.replaceAll('@' + label + ' ', ''));
    setAssets(current => current.filter(a => a.asset_id !== asset.asset_id));
  }
  return { home, mode, switchMode, clearDraft, agent,
    chooseAsset, removeAsset,
    input: { text, setText, files, setFiles, assets, setAssets, skill, setSkill, messageId,
      mention, setMention, library, libraryError, textarea, caret, restoreCaret } };

}

export type StudioComposerState = ReturnType<typeof useStudioComposer>;

function AgentInput({ state }: { state: StudioComposerState }) {
  const { agent, home, removeAsset } = state;
  const [, navigate] = useLocation();
  const { text, setText, files, setFiles, assets, skill, messageId, setMention, libraryError, textarea, caret } = state.input;
  const fileInput = useRef<HTMLInputElement>(null);
  const refInputId = useId();
  const [refExpanded, setRefExpanded] = useState(false);
  const [refHovered, setRefHovered] = useState<number | null>(null);
  const [refDrawerOpen, setRefDrawerOpen] = useState(false);
  const [slotLightbox, setSlotLightbox] = useState<string | null>(null);
  const isLongText = text.length > 140 || text.split('\n').length > 4;
  const autoRows = Math.min(10, Math.max(3, Math.ceil(text.length / 44), text.split('\n').length));
  const sending = useRef(false);
  const settings = agent.session ?? agent.draft;
  const running = agent.session?.status === 'running';
  const busy = agent.pending || running || agent.session?.status === 'awaiting_approval';
  const ready = settings.model && settings.model_alias && agent.models?.models.some(
    m => m.model === settings.model && m.alias === settings.model_alias);
  const canSend = !agent.waitingForSession && !busy && ready && Boolean(text.trim() || files.length || assets.length);

  const fileUrls = useMemo(() => files.map(file => URL.createObjectURL(file)), [files]);
  useEffect(() => () => fileUrls.forEach(u => URL.revokeObjectURL(u)), [fileUrls]);

  async function send() {
    if (!canSend || sending.current) return;
    sending.current = true;
    try {
      messageId.current ??= crypto.randomUUID();
      const sent = await agent.sendStudio(serializeMentions(text.trim()), files, assets.map(a => a.asset_id), skill, messageId.current);
      if (!sent) return;
      state.clearDraft();
      if (home) {
        updateStudioView({ mode: 'agent', activeSessionId: sent.session_id });
        navigate('/studio');
      }
    } finally { sending.current = false; }
  }

  function removeFile(index: number) {
    if (agent.pending) return;
    setText(current => renumberMentions(current, '图', index + 1));
    setFiles(current => current.filter((_, n) => n !== index));
  }

  function clearAllFiles() {
    if (agent.pending) return;
    setText(current => current.replace(/@(?:图片|图)\d+\s?/g, ''));
    setFiles([]);
    setRefDrawerOpen(false);
    setRefExpanded(false);
    setRefHovered(null);
  }

  useEffect(() => {
    if (files.length === 0) setRefDrawerOpen(false);
  }, [files.length]);

  const hoveredThumb = refHovered !== null ? fileUrls[refHovered] : null;

  return <div
    data-testid="studio-agent-shell"
    className="bg-glass shell-glow relative z-20 mx-auto flex max-w-[780px] flex-col gap-2 rounded-xl border border-input px-4 py-3.5 backdrop-blur-glass"
  >
    <FileInput ref={fileInput} id={refInputId} aria-label="选择参考图" multiple accept="image/*" className="hidden" onChange={event => {
      const next = Array.from(event.target.files ?? []);
      const added = next.slice(0, 16 - files.length);
      setText(current => current.replace(createMentionTokenRegex(), (match, kind: string, number: string) =>
        ['图片', '图'].includes(kind) && Number(number) > files.length ? '@图' + (Number(number) + added.length) : match));
      setFiles(current => [...current, ...added]); event.target.value = '';
    }} />
    {hoveredThumb && (
      <div
        data-testid="reference-hover-preview"
        className="shell-glow pointer-events-none absolute -top-3 z-50 w-[168px] -translate-y-full overflow-hidden rounded-xl transition-[left] duration-200 ease-out"
        style={{
          left: `${16 + (refDrawerOpen ? (refHovered ?? 0) * (REF_W + 8) : (refHovered ?? 0) * REF_STEP)}px`,
        }}
      >
        <img src={hoveredThumb} alt="参考素材预览" className="max-h-[220px] w-full rounded-xl object-cover" />
      </div>
    )}
    {refDrawerOpen && files.length > 0 && (
      <div data-testid="reference-drawer" className="border-b border-border/70 pb-3">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" type="button" className="h-7 rounded-lg px-2.5 text-xs">
              全部 ({files.length})
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              data-testid="reference-drawer-clear"
              onClick={clearAllFiles}
              className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              清空全部素材
            </Button>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              data-testid="reference-drawer-collapse"
              aria-label="收起参考素材"
              onClick={() => { setRefDrawerOpen(false); setRefHovered(null); }}
              className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
            >
              <CollapseIcon size="sm" />
            </Button>
          </div>
        </div>
        <div className="thin-scrollbar flex items-center gap-2 overflow-x-auto pb-1 pt-1">
          {files.map((file, i) => {
            const thumb = fileUrls[i];
            return (
              <div
                key={i}
                data-testid="reference-drawer-item"
                className="group relative shrink-0"
                style={{ width: REF_W, height: REF_H }}
                onMouseEnter={() => setRefHovered(i)}
                onMouseLeave={() => setRefHovered(null)}
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="查看参考图大图"
                  onClick={thumb ? () => setSlotLightbox(thumb) : undefined}
                  onKeyDown={thumb
                    ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSlotLightbox(thumb); } }
                    : undefined}
                  className="relative h-full w-full cursor-zoom-in overflow-hidden rounded-lg border-[1.5px] border-white bg-card"
                >
                  {thumb && <img src={thumb} alt={file.name} className="h-full w-full object-cover" />}
                  <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-scrim px-1 text-xs leading-4 text-foreground/90">
                    图{i + 1}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="icon"
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  onClick={e => { e.stopPropagation(); removeFile(i); }}
                  className="absolute -right-1.5 -top-1.5 z-10 flex size-[18px] items-center justify-center rounded-full border border-border bg-scrim p-0 text-foreground/80 opacity-0 backdrop-blur-glass transition-opacity hover:bg-destructive hover:text-foreground group-hover:opacity-100"
                >
                  <CloseIcon size="sm" />
                </Button>
              </div>
            );
          })}
          {files.length < 16 && (
            <Label
              htmlFor={refInputId}
              aria-label="上传参考图"
              className="flex shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-secondary text-muted-foreground transition-colors hover:border-input hover:text-foreground"
              style={{ width: REF_W, height: REF_H }}
            >
              <AddIcon size="md" />
              <span className="text-xs">参考内容</span>
            </Label>
          )}
        </div>
      </div>
    )}
    <div className="flex min-h-[78px] items-start gap-3.5">
      {!(refDrawerOpen && files.length > 0) && (
        <div className="relative h-[78px] shrink-0 overflow-visible" style={{ width: REF_W + 14 }}>
          {files.length === 0 ? (
            <Label
              htmlFor={refInputId}
              aria-label="上传参考图"
              className="absolute left-0 top-1/2 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-secondary transition-all duration-200 hover:-translate-y-1 hover:border-input hover:brightness-110"
              style={{ width: REF_W, height: REF_H, transform: 'translateY(-50%) rotate(-8deg)' }}
            >
              <AddIcon size="lg" className="text-muted-foreground" />
            </Label>
          ) : (
            <div
              className="absolute inset-y-0 left-0 overflow-visible"
              style={{
                width: refExpanded ? `${(files.length > 1 ? 2 : 1) * REF_STEP + REF_W + 14}px` : `${REF_W + 14}px`,
                transition: 'width 300ms ease',
              }}
              onMouseLeave={() => { setRefExpanded(false); setRefHovered(null); }}
            >
              {files.map((file, i) => {
                const hideInExpanded = refExpanded && (files.length > 2 ? i >= 1 : i >= 2);
                if (hideInExpanded) return null;
                const hovered = refHovered === i;
                const angle = refExpanded ? (i === 0 ? -6 : 4) : collapseAngle(i);
                const thumb = fileUrls[i];
                const zIndex = refExpanded ? 10 + i * 10 : files.length - i;
                return (
                  <div
                    key={i}
                    className="absolute left-0 top-1/2"
                    style={{
                      width: REF_W,
                      height: REF_H,
                      zIndex,
                      left: refExpanded ? `${i * REF_STEP}px` : '0px',
                      transform: `translateY(calc(-50% + ${hovered ? REF_HOVER_LIFT : 0}px)) rotate(${angle}deg) scale(${hovered ? REF_HOVER_SCALE : 1})`,
                      transition: 'left 300ms ease, transform 250ms ease',
                    }}
                    onMouseEnter={() => { setRefExpanded(true); setRefHovered(i); }}
                    onMouseLeave={() => setRefHovered(null)}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label="查看参考图大图"
                      onClick={thumb ? () => setSlotLightbox(thumb) : undefined}
                      onKeyDown={thumb
                        ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSlotLightbox(thumb); } }
                        : undefined}
                      className="relative h-full w-full cursor-zoom-in overflow-hidden rounded-lg border-[1.5px] border-white bg-card"
                    >
                      {thumb && <img src={thumb} alt={file.name} className="h-full w-full object-cover" />}
                      <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-scrim px-1 text-xs leading-4 text-foreground/90">
                        图{i + 1}
                      </span>
                    </div>
                  </div>
                );
              })}
              {refHovered !== null && files[refHovered] && (
                <Button
                  variant="secondary"
                  size="icon"
                  type="button"
                  aria-label={`移除 ${files[refHovered].name}`}
                  onMouseEnter={() => { setRefExpanded(true); setRefHovered(refHovered); }}
                  onClick={e => { e.stopPropagation(); removeFile(refHovered); }}
                  className="absolute z-50 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-scrim p-0 text-foreground/80 backdrop-blur-glass transition-all duration-200 hover:bg-destructive hover:text-foreground"
                  style={{
                    left: `${(refExpanded ? refHovered * REF_STEP : 0) + REF_W - 11}px`,
                    top: `calc(50% - ${REF_H / 2 + 11}px)`,
                  }}
                >
                  <CloseIcon size="sm" />
                </Button>
              )}
              {refExpanded && files.length > 2 && (
                <div
                  role="button"
                  tabIndex={0}
                  data-testid="reference-drawer-expand"
                  aria-label="展开全部参考素材"
                  onClick={() => { setRefDrawerOpen(true); setRefExpanded(false); setRefHovered(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setRefDrawerOpen(true);
                      setRefExpanded(false);
                      setRefHovered(null);
                    }
                  }}
                  className="absolute top-1/2 flex cursor-pointer items-center justify-center overflow-hidden rounded-lg border-[1.5px] border-white bg-card text-white transition-transform duration-200 hover:-translate-y-1 hover:scale-104"
                  style={{
                    width: REF_W,
                    height: REF_H,
                    left: `${REF_STEP}px`,
                    zIndex: 20,
                    transform: 'translateY(-50%) rotate(4deg)',
                  }}
                >
                  {fileUrls[1] && (
                    <img src={fileUrls[1]} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40 blur-[1px]" />
                  )}
                  <span className="relative z-10 flex h-full w-full items-center justify-center bg-scrim/70 backdrop-blur-glass">
                    <ExpandIcon size="md" />
                  </span>
                </div>
              )}
              {files.length < 16 && (
                <Label
                  htmlFor={refInputId}
                  aria-label="上传参考图"
                  onMouseEnter={() => setRefExpanded(true)}
                  className="absolute flex cursor-pointer flex-col items-center justify-center overflow-hidden border border-border bg-secondary text-muted-foreground hover:border-input hover:bg-card hover:text-foreground"
                  style={{
                    width: refExpanded ? REF_W : 26,
                    height: refExpanded ? REF_H : 26,
                    left: refExpanded ? `${(files.length > 1 ? 2 : 1) * REF_STEP}px` : `${REF_W - 14}px`,
                    top: refExpanded ? '50%' : `calc(50% + ${REF_H / 2 - 8}px)`,
                    borderRadius: refExpanded ? '8px' : '9999px',
                    zIndex: 30,
                    transform: refExpanded ? 'translateY(-50%) rotate(-5deg)' : 'translateY(-50%) rotate(0deg)',
                    transition: 'left 300ms ease, top 300ms ease, width 300ms ease, height 300ms ease, border-radius 300ms ease, transform 300ms ease, background-color 200ms ease, color 200ms ease',
                  }}
                >
                  <AddIcon size={refExpanded ? 'md' : 'sm'} className="shrink-0" />
                  <span
                    className={`overflow-hidden whitespace-nowrap text-xs transition-all duration-300 ${
                      refExpanded ? 'mt-1 max-h-4 opacity-100' : 'mt-0 max-h-0 opacity-0'
                    }`}
                  >
                    参考内容
                  </span>
                </Label>
              )}
            </div>
          )}
        </div>
      )}
      <Textarea
        ref={textarea}
        disabled={agent.pending}
        rows={autoRows}
        value={text}
        placeholder="输入想法或上传参考，和 Agent 一起创作"
        className={`${isLongText ? 'thin-scrollbar' : 'no-scrollbar'} min-h-[72px] max-h-[240px] w-full flex-1 resize-none overflow-y-auto rounded-md border-0 bg-transparent py-1 pl-2 pr-14 text-sm leading-6 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0`}
        onSelect={event => { caret.current = event.currentTarget.selectionStart; }}
        onChange={event => {
          caret.current = event.target.selectionStart;
          setText(event.target.value);
          if (event.target.value.slice(0, caret.current).endsWith('@')) setMention(true);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); void send();
          }
        }}
      />
    </div>
    {!!assets.length && <div className="flex flex-wrap gap-1 pr-14">{assets.map(asset =>
      <Button key={asset.asset_id} variant="secondary" size="sm"
        disabled={agent.pending} aria-label={`移除引用 ${asset.title}`} onClick={() => removeAsset(asset)}>
        {asset.title}<CloseIcon size="sm" /></Button>)}</div>}
    {(agent.error || libraryError) && <p role="alert" className="pr-14 text-xs text-destructive">{agent.error || libraryError}</p>}
    <Button
      type="button"
      size="icon"
      className="absolute bottom-3.5 right-4 h-10 w-10 rounded-full"
      aria-label={running ? '停止' : '发送'}
      disabled={running ? agent.pending : !canSend}
      onClick={() => running ? void agent.stop() : void send()}
    >
      {running ? <StopIcon size="lg" /> : <ArrowUpIcon size="lg" />}
    </Button>
    {slotLightbox && <Lightbox src={slotLightbox} onClose={() => setSlotLightbox(null)} />}
  </div>;
}

export function StudioComposer({ state, children }: { state: StudioComposerState; children: ReactNode }) {
  const { agent, chooseAsset } = state;
  const { skill, setSkill, mention, setMention, library, textarea, restoreCaret } = state.input;
  const settings = agent.session ?? agent.draft;
  const running = agent.session?.status === 'running';
  const busy = agent.pending || running || agent.session?.status === 'awaiting_approval';
  const creation = settings.creation_mode ?? 'all';
  return <div className="pointer-events-auto mx-auto w-full max-w-[780px]">
    <motion.div
      key={state.mode}
      initial={{ opacity: 0.85, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {state.mode === 'creation' ? children : <AgentInput state={state} />}
    </motion.div>
    <div
      className="relative -mt-3 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border border-t-0 border-input studio-mode-bar px-3 pb-1.5 pt-4 transition-all duration-300"
    >
      <Segmented disabled={state.agent.pending} aria-label="输入模式" className="inline-grid grid-cols-2">
        <SegmentedItem value="creation" selected={state.mode === 'creation'} onSelect={() => state.switchMode('creation')} className="h-7 px-3 text-xs">创作</SegmentedItem>
        <SegmentedItem value="agent" selected={state.mode === 'agent'} onSelect={() => state.switchMode('agent')} className="h-7 px-3 text-xs">Agent</SegmentedItem>
      </Segmented>
      {state.mode === 'agent' && (
        <div aria-label="创作设置" className="ml-auto flex flex-wrap items-center gap-1">
          <CanvasAgentModelPicker models={agent.models} alias={settings.model_alias ?? null} model={settings.model ?? null}
            disabled={busy} onSelect={choice => void agent.updateSettings({ model_alias: choice.alias, model: choice.model })} />
          <span aria-hidden="true" className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
          <CanvasAgentModeMenu mode={creation} disabled={busy} onSelect={creation_mode => void agent.updateSettings({ creation_mode })} />
          <CanvasAgentPreferencePicker models={agent.generationModels} mode={creation} auto={settings.auto_models ?? true}
            preferred={settings.preferred_models ?? []} disabled={busy} onChange={agent.updateSettings} />
          <CanvasAgentPermissionMenu auto={(settings.permission_mode ?? 'auto') === 'auto'} disabled={busy}
            confirmAbove={agent.confirmAbove} onModeChange={permission_mode => void agent.updateSettings({ permission_mode })}
            onConfirmAboveChange={agent.updateConfirmAbove} />
          <CanvasAgentSkillPicker label={skill ?? '技能'} skills={agent.skills} selected={skill}
            onSelect={name => setSkill(name === skill ? null : name)} disabled={busy} onChanged={agent.reloadSkills} />
          <Popover open={mention} onOpenChange={setMention}><PopoverTrigger asChild>
            <Button size="sm" variant="ghost" disabled={agent.pending} aria-label="引用资产">@</Button>
          </PopoverTrigger><PopoverContent align="end" className="max-h-64 overflow-auto p-1"
            onCloseAutoFocus={event => {
              if (restoreCaret.current === null) return;
              event.preventDefault();
              textarea.current?.focus();
              textarea.current?.setSelectionRange(restoreCaret.current, restoreCaret.current);
              restoreCaret.current = null;
            }}>
            {library.map(asset => <Button key={asset.asset_id} size="sm" variant="ghost" className="w-full justify-start"
              onClick={() => chooseAsset(asset)}>{asset.title}</Button>)}
            {!library.length && <p className="p-2 text-xs text-muted-foreground">暂无可引用资产</p>}
          </PopoverContent></Popover>
        </div>
      )}
    </div>
  </div>;
}
