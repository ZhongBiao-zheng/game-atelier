import { Link } from 'wouter';
import { AudioLines, Clapperboard, Image as ImageIcon, RotateCcw, Type, ZoomIn } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { KeyView } from '@/api/keys';
import {
  CanvasAudioSettings,
  CanvasImageSettings,
  CanvasModelPicker,
  CanvasTextSettings,
  OptionTrack,
  type CanvasModelChoice,
} from '@/components/canvas/CanvasGenerationControls';
import { CANVAS_UPSCALE_TARGETS } from '@/components/canvas/canvasImageToolbar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VideoControls } from '@/components/studio/VideoControls';
import { imageControlCaps, QUALITY_LABELS, type Quality } from '@/lib/imageControlCaps';
import { imageSizeMode } from '@/lib/imageSizeMode';
import { cn } from '@/lib/utils';
import {
  CANVAS_GENERATION_MODE_LABELS,
  canvasGenerationModelSupportsMode,
  canvasGenerationPreferenceForModel,
  canvasUpscaleAutoChoice,
  canvasUpscaleModelChoices,
  canvasVideoEditCaps,
  supportsCanvasTextReasoning,
} from '@/pages/canvasEditorModel';
import type {
  CanvasGenerationDefault,
  CanvasGenerationDefaults,
  CanvasGenerationDraft,
  CanvasGenerationMode,
  CanvasUpscalePreferences,
  CanvasUpscaleTarget,
  CanvasUpscaleTierPreferences,
} from '@/schema/canvas';
import type { JobParams } from '@/schema/jobs';

const MODES = ['text', 'image', 'video', 'audio'] as const;
export type CanvasGenerationPreferencesTab = CanvasGenerationMode | 'upscale';
const TABS: CanvasGenerationPreferencesTab[] = [...MODES, 'upscale'];
const TAB_LABELS: Record<CanvasGenerationPreferencesTab, string> = {
  ...CANVAS_GENERATION_MODE_LABELS,
  upscale: 'AI高清',
};
const TAB_ICONS = {
  text: Type,
  image: ImageIcon,
  video: Clapperboard,
  audio: AudioLines,
  upscale: ZoomIn,
};

function cloneDefaults(value: CanvasGenerationDefaults): CanvasGenerationDefaults {
  return {
    text: { selection: value.text.selection && { ...value.text.selection }, params: { ...value.text.params } },
    image: { selection: value.image.selection && { ...value.image.selection }, params: { ...value.image.params } },
    video: { selection: value.video.selection && { ...value.video.selection }, params: { ...value.video.params } },
    audio: { selection: value.audio.selection && { ...value.audio.selection }, params: { ...value.audio.params } },
  };
}

function cloneUpscale(value: CanvasUpscalePreferences): CanvasUpscalePreferences {
  const tiers = {} as CanvasUpscalePreferences['tiers'];
  for (const target of CANVAS_UPSCALE_TARGETS) {
    const tier = value.tiers[target.id];
    tiers[target.id] = { ...tier, selection: tier.selection && { ...tier.selection } };
  }
  return { tiers };
}

/** 失效的固定模型回到自动选择；模型没有质量档时不保存 quality。 */
function upscaleForSave(value: CanvasUpscalePreferences, keys: KeyView[]): CanvasUpscalePreferences {
  const choices = canvasUpscaleModelChoices(keys);
  const automatic = canvasUpscaleAutoChoice(keys);
  const tiers = {} as CanvasUpscalePreferences['tiers'];
  for (const target of CANVAS_UPSCALE_TARGETS) {
    const tier = value.tiers[target.id];
    const selected = tier.selection
      ? choices.find(choice => choice.key.alias === tier.selection?.alias && choice.model.id === tier.selection.model) ?? null
      : null;
    const effective = selected ?? (target.autoQuality ? automatic : null);
    const qualities = effective
      ? imageControlCaps(effective.model.id, effective.key.provider, effective.key.base_url).qualities
      : null;
    tiers[target.id] = {
      selection: selected ? tier.selection : null,
      quality: qualities?.includes(tier.quality as Quality) ? tier.quality : null,
      prompt: tier.prompt,
    };
  }
  return { tiers };
}

function defaultsForSave(
  value: CanvasGenerationDefaults,
  keys: KeyView[],
): CanvasGenerationDefaults {
  function normalize<M extends CanvasGenerationMode>(mode: M): CanvasGenerationDefault<M> {
    const current = value[mode];
    if (!current.selection) {
      const automatic = keys.flatMap(key => key.models.map(model => ({ key, model })))
        .find(choice => canvasGenerationModelSupportsMode(choice.key, choice.model, mode));
      if (!automatic) return current;
      const normalized = canvasGenerationPreferenceForModel(
        automatic.key,
        automatic.model,
        mode,
        current.params as JobParams,
      );
      return { selection: null, params: normalized?.params ?? current.params };
    }
    const key = keys.find(candidate => candidate.alias === current.selection?.alias);
    const model = key?.models.find(candidate => candidate.id === current.selection?.model);
    if (!key || !model || !canvasGenerationModelSupportsMode(key, model, mode)) {
      return { selection: null, params: {} };
    }
    return canvasGenerationPreferenceForModel(key, model, mode, current.params as JobParams)
      ?? { selection: null, params: {} };
  }
  return {
    text: normalize('text'),
    image: normalize('image'),
    video: normalize('video'),
    audio: normalize('audio'),
  };
}

export function CanvasGenerationPreferencesDialog({
  open,
  value,
  upscale,
  keys,
  saving,
  error,
  initialTab = 'image',
  onOpenChange,
  onSave,
}: {
  open: boolean;
  value: CanvasGenerationDefaults;
  upscale: CanvasUpscalePreferences;
  keys: KeyView[];
  saving: boolean;
  error: string | null;
  /** 从「前往配置」进来时直接落在 AI高清 页签。 */
  initialTab?: CanvasGenerationPreferencesTab;
  onOpenChange: (open: boolean) => void;
  onSave: (value: CanvasGenerationDefaults, upscale: CanvasUpscalePreferences) => void;
}) {
  const [draft, setDraft] = useState(() => cloneDefaults(value));
  const [upscaleDraft, setUpscaleDraft] = useState<CanvasUpscalePreferences>(() => cloneUpscale(upscale));
  const [upscaleTarget, setUpscaleTarget] = useState<CanvasUpscaleTarget>('2K');
  const [tab, setTab] = useState<CanvasGenerationPreferencesTab>(initialTab);
  const [sizeNotice, setSizeNotice] = useState<string | null>(null);
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(cloneDefaults(value));
    setUpscaleDraft(cloneUpscale(upscale));
    setUpscaleTarget('2K');
    setTab(initialTab);
    setSizeNotice(null);
  }, [initialTab, open, upscale, value]);

  // 生成类型页签之外还有 AI高清；下面按模态计算的部分在 AI高清 页签下不渲染，取 image 只为类型收窄。
  const activeMode: CanvasGenerationDraft['mode'] = tab === 'upscale' ? 'image' : tab;
  const preference = draft[activeMode];
  const upscaleChoices = useMemo(() => canvasUpscaleModelChoices(keys), [keys]);
  const upscaleAutoChoice = useMemo(() => canvasUpscaleAutoChoice(keys), [keys]);
  const upscaleTargetSpec = CANVAS_UPSCALE_TARGETS.find(target => target.id === upscaleTarget) ?? CANVAS_UPSCALE_TARGETS[0];
  const upscaleTier = upscaleDraft.tiers[upscaleTarget];
  const selectedUpscaleChoice = upscaleTier.selection
    ? upscaleChoices.find(choice => (
        choice.key.alias === upscaleTier.selection?.alias
        && choice.model.id === upscaleTier.selection.model
      )) ?? null
    : null;
  const effectiveUpscaleChoice = selectedUpscaleChoice ?? (upscaleTargetSpec.autoQuality ? upscaleAutoChoice : null);
  const upscaleStale = upscaleTier.selection !== null && selectedUpscaleChoice === null;
  const upscaleQualities = effectiveUpscaleChoice
    ? imageControlCaps(effectiveUpscaleChoice.model.id, effectiveUpscaleChoice.key.provider, effectiveUpscaleChoice.key.base_url).qualities
    : null;
  const upscaleQuality = upscaleQualities?.includes(upscaleTier.quality as Quality)
    ? upscaleTier.quality as Quality
    : upscaleTargetSpec.autoQuality && upscaleQualities?.includes(upscaleTargetSpec.autoQuality)
      ? upscaleTargetSpec.autoQuality
      : upscaleQualities?.[0] ?? null;

  function patchUpscaleTier(patch: Partial<CanvasUpscaleTierPreferences>) {
    setUpscaleDraft(current => ({
      tiers: { ...current.tiers, [upscaleTarget]: { ...current.tiers[upscaleTarget], ...patch } },
    }));
  }

  const choices = useMemo<CanvasModelChoice[]>(() => keys.flatMap(key => key.models
    .filter(model => canvasGenerationModelSupportsMode(key, model, activeMode))
    .map(model => ({ key, model }))), [activeMode, keys]);
  const selectedChoice = preference.selection
    ? choices.find(choice => (
        choice.key.alias === preference.selection?.alias
        && choice.model.id === preference.selection.model
      )) ?? null
    : null;
  const effectiveChoice = selectedChoice ?? choices[0] ?? null;
  const stale = preference.selection !== null && selectedChoice === null;
  const effectivePreference = effectiveChoice
    ? canvasGenerationPreferenceForModel(
        effectiveChoice.key,
        effectiveChoice.model,
        activeMode,
        selectedChoice || preference.selection === null ? preference.params as JobParams : {},
      )
    : null;
  const params = (effectivePreference?.params ?? {}) as JobParams;

  function setPreference(mode: CanvasGenerationDraft['mode'], next: CanvasGenerationDefault) {
    setDraft(current => ({ ...current, [mode]: next }));
  }

  function selectModel(choice: CanvasModelChoice) {
    const next = canvasGenerationPreferenceForModel(
      choice.key,
      choice.model,
      activeMode,
      selectedChoice || preference.selection === null ? preference.params as JobParams : {},
    );
    if (next) {
      setSizeNotice(activeMode === 'image' && imageSizeMode(next.params as JobParams) !== imageSizeMode(params)
        ? '当前模型不支持原尺寸模式，已切换为比例' : null);
      setPreference(activeMode, next);
    }
  }

  function patchParams(patch: JobParams) {
    if (!effectiveChoice) return;
    const merged = { ...params, ...patch };
    const next = canvasGenerationPreferenceForModel(
      effectiveChoice.key,
      effectiveChoice.model,
      activeMode,
      merged,
    );
    if (next) {
      setPreference(activeMode, {
        selection: preference.selection,
        params: next.params,
      });
    }
  }

  const imageCaps = activeMode === 'image' && effectiveChoice
    ? imageControlCaps(
        effectiveChoice.model.id,
        effectiveChoice.key.provider,
        effectiveChoice.key.base_url,
      )
    : null;
  const videoCaps = activeMode === 'video' && effectiveChoice
    ? canvasVideoEditCaps(effectiveChoice.model.id, effectiveChoice.model.protocol)
    : null;
  const videoMode = videoCaps?.modes.includes('omni') && params.frame_mode === 'auto'
    ? 'omni'
    : videoCaps?.modes[0] ?? 'firstlast';

  return (
    <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
      <DialogContent
        ref={dialogContentRef}
        id="canvas-generation-preferences-dialog"
        className="h-[min(92dvh,44rem)] min-w-0 max-w-3xl grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-visible"
        aria-busy={saving}
        onOpenAutoFocus={event => {
          event.preventDefault();
          activeTabRef.current?.focus();
        }}
        onEscapeKeyDown={event => {
          if (dialogContentRef.current?.querySelector('[data-toolbar-popover]')) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>生成偏好</DialogTitle>
          <DialogDescription>
            为新建节点设置默认渠道、模型和参数。已有节点、运行快照与项目历史不会被改动。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-x-hidden overflow-y-auto">
        {activeMode === 'image' && sizeNotice && <p role="status" className="text-xs text-muted-foreground">{sizeNotice}</p>}
        <div role="tablist" aria-label="生成类型" className="grid grid-cols-5 gap-1 rounded-xl border border-border bg-card p-1">
          {TABS.map(mode => {
            const Icon = TAB_ICONS[mode];
            const active = tab === mode;
            return (
              <button
                key={mode}
                ref={active ? activeTabRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="canvas-generation-preference-panel"
                onClick={() => setTab(mode)}
                className={cn(
                  'relative flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  active ? 'text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{TAB_LABELS[mode]}</span>
                {active && <span className="absolute inset-x-3 bottom-0 h-px bg-primary" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        {tab === 'upscale' ? (
        <section
          id="canvas-generation-preference-panel"
          role="tabpanel"
          aria-label="AI高清偏好"
          className="space-y-4 rounded-xl border border-border bg-card p-4"
        >
          <div className="space-y-2">
            <p className="text-sm font-medium">档位</p>
            <OptionTrack
              label="选择 AI高清档位"
              values={CANVAS_UPSCALE_TARGETS.map(target => target.id)}
              selected={upscaleTarget}
              onSelect={value => setUpscaleTarget(value)}
            />
          </div>
          <div className="space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{upscaleTarget} 模型</p>
                <p className="text-xs text-muted-foreground">
                  {upscaleTargetSpec.autoQuality
                    ? '未固定时自动选质量可调的 Nano Banana。'
                    : `${upscaleTarget} 没有自动路线，需手动选择模型。`}
                </p>
              </div>
              {upscaleTargetSpec.autoQuality && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={upscaleTier.selection === null}
                  onClick={() => patchUpscaleTier({ selection: null })}
                >
                  <RotateCcw aria-hidden="true" />恢复自动选择
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/20 p-2">
              <CanvasModelPicker
                choices={upscaleChoices}
                alias={effectiveUpscaleChoice?.key.alias ?? null}
                model={effectiveUpscaleChoice?.model.id ?? ''}
                menuDirection="down"
                portalContainerRef={dialogContentRef}
                onSelect={choice => patchUpscaleTier({
                  selection: { alias: choice.key.alias, model: choice.model.id },
                })}
              />
              <span className="shrink-0 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                {upscaleTier.selection ? '固定模型' : effectiveUpscaleChoice ? '自动选择' : '未配置'}
              </span>
            </div>
            {upscaleStale && (
              <p role="alert" className="text-sm text-destructive">
                已保存的 {upscaleTarget} 模型不再可用。保存后将{upscaleTargetSpec.autoQuality ? '改为自动选择' : '清空该档位'}。
              </p>
            )}
            {!upscaleChoices.length && (
              <p role="alert" className="text-sm text-destructive">
                当前没有可用于 AI高清 的图片模型，请先在供应商设置中接入。
              </p>
            )}
          </div>
          {effectiveUpscaleChoice && (
            <div className="space-y-2 border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">分辨率</p>
                <p className="text-xs text-muted-foreground">
                  {upscaleQualities
                    ? `该模型按质量档出图；目标长边 ${upscaleTargetSpec.longEdge}px。`
                    : `该模型按像素出图，直接以长边 ${upscaleTargetSpec.longEdge}px 等比放大。`}
                </p>
              </div>
              {upscaleQualities && upscaleQuality && (
                <OptionTrack
                  label="选择 AI高清质量"
                  values={upscaleQualities}
                  selected={upscaleQuality}
                  getLabel={value => QUALITY_LABELS[value]}
                  onSelect={value => patchUpscaleTier({ quality: value })}
                />
              )}
            </div>
          )}
          <div className="space-y-2 border-t border-border pt-4">
            <label htmlFor="canvas-upscale-prompt" className="block">
              <span className="text-sm font-medium">{upscaleTarget} 提示词</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">该档位每次 AI高清 都用这段提示词重绘；清空后保存即恢复内置提示词。</span>
            </label>
            <Textarea
              id="canvas-upscale-prompt"
              rows={6}
              value={upscaleTier.prompt}
              onChange={event => patchUpscaleTier({ prompt: event.target.value })}
            />
          </div>
        </section>
        ) : (
        <section
          id="canvas-generation-preference-panel"
          role="tabpanel"
          aria-label={`${CANVAS_GENERATION_MODE_LABELS[activeMode]}生成偏好`}
          className="space-y-4 rounded-xl border border-border bg-card p-4"
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">默认模型</p>
                <p className="text-xs text-muted-foreground">只列出画布运行器当前可以执行的模型。</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={preference.selection === null}
                onClick={() => setPreference(activeMode, { selection: null, params })}
              >
                <RotateCcw aria-hidden="true" />恢复自动选择
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/20 p-2">
              <CanvasModelPicker
                choices={choices}
                alias={effectiveChoice?.key.alias ?? null}
                model={effectiveChoice?.model.id ?? ''}
                menuDirection="down"
                portalContainerRef={dialogContentRef}
                onSelect={selectModel}
              />
              <span className="shrink-0 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                {preference.selection ? '固定模型' : '自动选择'}
              </span>
            </div>
            {stale && (
              <p role="alert" className="text-sm text-destructive">
                已保存的默认模型不再可用。新建节点会自动选择首个可用模型，保存后即可更新偏好。
              </p>
            )}
            {!choices.length && (
              <p role="status" className="text-sm text-muted-foreground">
                当前没有可运行的{CANVAS_GENERATION_MODE_LABELS[activeMode]}模型。
              </p>
            )}
          </div>

          {effectiveChoice && (
            <div className="space-y-2 border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">默认参数</p>
                <p className="text-xs text-muted-foreground">参数可与自动选模独立保存；节点内仍可单独修改。</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {activeMode === 'text' && (
                  <CanvasTextSettings
                    supportsReasoning={supportsCanvasTextReasoning(effectiveChoice.model.protocol)}
                    params={params}
                    menuDirection="up"
                    portalContainerRef={dialogContentRef}
                    onPatch={patch => patchParams(patch)}
                  />
                )}
                {activeMode === 'image' && imageCaps && (
                  <CanvasImageSettings
                    caps={imageCaps}
                    model={effectiveChoice.model.id}
                    baseUrl={effectiveChoice.key.base_url}
                    params={params}
                    menuDirection="up"
                    portalContainerRef={dialogContentRef}
                    onPatch={patchParams}
                  />
                )}
                {activeMode === 'video' && videoCaps && (
                  <VideoControls
                    caps={videoCaps}
                    mode={videoMode}
                    duration={Number(params.duration ?? videoCaps.durations[0] ?? 5)}
                    resolution={String(params.resolution ?? videoCaps.resolutions[0] ?? '720p')}
                    ratio={String(params.ratio ?? videoCaps.ratios[0] ?? '16:9')}
                    quality={params.mode === 'pro' ? 'pro' : 'std'}
                    generateAudio={params.generate_audio !== false}
                    watermark={params.watermark === true}
                    menuDirection="up"
                    portalContainerRef={dialogContentRef}
                    onModeChange={mode => patchParams({ frame_mode: mode === 'omni' ? 'auto' : 'firstlast' })}
                    onDurationChange={duration => patchParams({ duration })}
                    onResolutionChange={resolution => patchParams({ resolution })}
                    onRatioChange={ratio => patchParams({ ratio })}
                    onQualityChange={quality => patchParams({ mode: quality })}
                    onGenerateAudioChange={generateAudio => patchParams({ generate_audio: generateAudio })}
                    onWatermarkChange={watermark => patchParams({ watermark })}
                  />
                )}
                {activeMode === 'audio' && (
                  <CanvasAudioSettings
                    params={params}
                    menuDirection="up"
                    portalContainerRef={dialogContentRef}
                    onPatch={patch => patchParams(patch)}
                  />
                )}
              </div>
            </div>
          )}
        </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/20 px-4 py-3">
          <p className="text-xs text-muted-foreground">密钥、渠道和模型清单仍由全局设置统一管理。</p>
          <Button asChild type="button" variant="outline" size="sm">
            {/* 原生 <a> 会整页刷新，把画布上还没落盘的编辑一起带走。 */}
            <Link href="/settings">管理供应商</Link>
          </Button>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            type="button"
            disabled={saving}
            onClick={() => onSave(defaultsForSave(draft, keys), upscaleForSave(upscaleDraft, keys))}
          >
            {saving ? '保存中…' : '保存偏好'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
