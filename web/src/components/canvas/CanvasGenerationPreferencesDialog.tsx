import { AudioLines, Clapperboard, Image as ImageIcon, RotateCcw, Type } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { KeyView } from '@/api/keys';
import {
  CanvasAudioSettings,
  CanvasImageSettings,
  CanvasModelPicker,
  CanvasTextSettings,
  type CanvasModelChoice,
} from '@/components/canvas/CanvasGenerationControls';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VideoControls } from '@/components/studio/VideoControls';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { cn } from '@/lib/utils';
import {
  CANVAS_GENERATION_MODE_LABELS,
  canvasGenerationModelSupportsMode,
  canvasGenerationPreferenceForModel,
  canvasVideoEditCaps,
  supportsCanvasTextReasoning,
} from '@/pages/canvasEditorModel';
import type {
  CanvasGenerationDefault,
  CanvasGenerationDefaults,
  CanvasGenerationDraft,
} from '@/schema/canvas';
import type { JobParams } from '@/schema/jobs';

const MODES = ['text', 'image', 'video', 'audio'] as const;
const MODE_ICONS = {
  text: Type,
  image: ImageIcon,
  video: Clapperboard,
  audio: AudioLines,
};

function cloneDefaults(value: CanvasGenerationDefaults): CanvasGenerationDefaults {
  return {
    text: { selection: value.text.selection && { ...value.text.selection }, params: { ...value.text.params } },
    image: { selection: value.image.selection && { ...value.image.selection }, params: { ...value.image.params } },
    video: { selection: value.video.selection && { ...value.video.selection }, params: { ...value.video.params } },
    audio: { selection: value.audio.selection && { ...value.audio.selection }, params: { ...value.audio.params } },
  };
}

function defaultsForSave(
  value: CanvasGenerationDefaults,
  keys: KeyView[],
): CanvasGenerationDefaults {
  function normalize(mode: CanvasGenerationDraft['mode']): CanvasGenerationDefault {
    const current = value[mode];
    if (!current.selection) return { selection: null, params: {} };
    const key = keys.find(candidate => candidate.alias === current.selection?.alias);
    const model = key?.models.find(candidate => candidate.id === current.selection?.model);
    if (!key || !model || !canvasGenerationModelSupportsMode(key, model, mode)) {
      return { selection: null, params: {} };
    }
    return canvasGenerationPreferenceForModel(key, model, mode, current.params)
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
  keys,
  saving,
  error,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  value: CanvasGenerationDefaults;
  keys: KeyView[];
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (value: CanvasGenerationDefaults) => void;
}) {
  const [draft, setDraft] = useState(() => cloneDefaults(value));
  const [activeMode, setActiveMode] = useState<CanvasGenerationDraft['mode']>('image');
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(cloneDefaults(value));
    setActiveMode('image');
  }, [open, value]);

  const preference = draft[activeMode];
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
        selectedChoice ? preference.params : {},
      )
    : null;
  const params = effectivePreference?.params ?? {};

  function setPreference(mode: CanvasGenerationDraft['mode'], next: CanvasGenerationDefault) {
    setDraft(current => ({ ...current, [mode]: next }));
  }

  function selectModel(choice: CanvasModelChoice) {
    const next = canvasGenerationPreferenceForModel(
      choice.key,
      choice.model,
      activeMode,
      selectedChoice ? preference.params : {},
    );
    if (next) setPreference(activeMode, next);
  }

  function patchParams(patch: JobParams, options: { resetSize?: boolean } = {}) {
    if (!effectiveChoice) return;
    const merged = { ...params, ...patch };
    if (options.resetSize) delete merged.size;
    const next = canvasGenerationPreferenceForModel(
      effectiveChoice.key,
      effectiveChoice.model,
      activeMode,
      merged,
    );
    if (next) setPreference(activeMode, next);
  }

  const imageCaps = activeMode === 'image' && effectiveChoice
    ? imageControlCaps(
        effectiveChoice.model.id,
        effectiveChoice.key.provider,
        effectiveChoice.model.protocol,
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
        <div role="tablist" aria-label="生成类型" className="grid grid-cols-4 gap-1 rounded-xl border border-border bg-card p-1">
          {MODES.map(mode => {
            const Icon = MODE_ICONS[mode];
            const active = activeMode === mode;
            return (
              <button
                key={mode}
                ref={active ? activeTabRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="canvas-generation-preference-panel"
                onClick={() => setActiveMode(mode)}
                className={cn(
                  'relative flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  active ? 'text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{CANVAS_GENERATION_MODE_LABELS[mode]}</span>
                {active && <span className="absolute inset-x-3 bottom-0 h-px bg-primary" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

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
                onClick={() => setPreference(activeMode, { selection: null, params: {} })}
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
                <p className="text-xs text-muted-foreground">调整参数时会固定当前模型；节点内仍可单独修改。</p>
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

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/20 px-4 py-3">
          <p className="text-xs text-muted-foreground">密钥、渠道和模型清单仍由全局设置统一管理。</p>
          <Button asChild type="button" variant="outline" size="sm">
            <a href="/settings">管理供应商</a>
          </Button>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={saving} onClick={() => onSave(defaultsForSave(draft, keys))}>
            {saving ? '保存中…' : '保存偏好'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
