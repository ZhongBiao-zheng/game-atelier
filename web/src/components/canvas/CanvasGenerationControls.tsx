import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Boxes, Check, Settings2 } from 'lucide-react';

import type { KeyView } from '@/api/keys';
import { RatioIcon } from '@/components/studio/RatioIcon';
import {
  ToolbarPopover,
  type ToolbarPopoverMenuProps,
} from '@/components/studio/ToolbarPopover';
import { QUALITY_LABELS, type ImageControlCaps, type Quality } from '@/lib/imageControlCaps';
import { cn } from '@/lib/utils';
import { normalizeStudioSizeForModel, type Resolution } from '@/lib/studioSize';
import {
  AUDIO_FORMAT_OPTIONS,
  AUDIO_SPEED_PRESETS,
  AUDIO_VOICE_OPTIONS,
  audioFormatLabel,
  audioSpeedLabel,
  audioVoiceLabel,
  normalizeAudioFormat,
  normalizeAudioSpeed,
  normalizeAudioVoice,
} from '@/lib/audioGeneration';
import type { JobParams } from '@/schema/jobs';

const REASONING_OPTIONS = ['auto', 'low', 'medium', 'high', 'xhigh'] as const;
const REASONING_LABELS: Record<(typeof REASONING_OPTIONS)[number], string> = {
  auto: '自动',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
};
const TEXT_TEMPERATURE_OPTIONS = ['auto', 0.2, 0.7, 1, 1.3] as const;
const TEXT_TEMPERATURE_LABELS: Record<string, string> = {
  auto: '自动',
  '0.2': '严谨',
  '0.7': '均衡',
  '1': '灵活',
  '1.3': '发散',
};
const TEXT_MAX_TOKEN_OPTIONS = ['auto', 512, 1024, 2048, 4096] as const;

export interface CanvasModelChoice {
  key: KeyView;
  model: KeyView['models'][number];
}

export function CanvasModelPicker({
  choices,
  alias,
  model,
  onSelect,
  getDescription,
  menuDirection = 'up',
  portalContainerRef,
}: {
  choices: CanvasModelChoice[];
  alias: string | null;
  model: string;
  onSelect: (choice: CanvasModelChoice) => void;
  getDescription?: (choice: CanvasModelChoice) => string | null;
} & ToolbarPopoverMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const selected = choices.find(choice => choice.key.alias === alias && choice.model.id === model);
  const grouped = choices.reduce<Array<{ key: KeyView; models: CanvasModelChoice[] }>>((groups, choice) => {
    const group = groups.find(item => item.key.alias === choice.key.alias);
    if (group) group.models.push(choice);
    else groups.push({ key: choice.key, models: [choice] });
    return groups;
  }, []);

  return (
    <div ref={anchorRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-label="选择生成模型"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Boxes className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{selected?.model.name || selected?.model.id || '选择模型'}</span>
        {selected && <span className="ml-auto shrink-0 text-muted-foreground">{selected.key.alias}</span>}
      </button>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        autoFocus
        direction={menuDirection}
        portalContainerRef={portalContainerRef}
        data-testid="canvas-model-popover"
        className={cn(
          portalContainerRef ? 'max-h-[45vh]' : 'max-h-[60vh]',
          'w-[320px] overflow-y-auto rounded-xl border border-border bg-card p-3',
        )}
      >
        {grouped.length ? (
          <div className="space-y-3">
            {grouped.map(group => (
              <section key={group.key.alias}>
                <div className="px-1 py-1 text-xs text-muted-foreground">
                  {group.key.alias} · {group.key.provider}
                </div>
                <div role="listbox" aria-label={`${group.key.alias} 可用模型`} className="rounded-lg bg-popover p-1">
                  {group.models.map(choice => {
                    const active = choice.key.alias === alias && choice.model.id === model;
                    const description = getDescription?.(choice);
                    return (
                      <button
                        key={`${choice.key.alias}:${choice.model.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          if (active) return;
                          onSelect(choice);
                          setOpen(false);
                          anchorRef.current?.querySelector<HTMLElement>('button')?.focus();
                        }}
                        className="flex min-h-12 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{choice.model.name || choice.model.id}</span>
                          {description && (
                            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                              {description}
                            </span>
                          )}
                        </span>
                        {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground">当前没有可用模型，请先在设置中配置密钥。</p>
        )}
      </ToolbarPopover>
    </div>
  );
}

export function CanvasImageSettings({
  caps,
  model,
  params,
  onPatch,
  menuDirection = 'up',
  portalContainerRef,
}: {
  caps: ImageControlCaps;
  model: string;
  params: JobParams;
  onPatch: (patch: JobParams, options?: { resetSize?: boolean }) => void;
} & ToolbarPopoverMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const ratio = String(params.ratio ?? caps.ratios[0] ?? '1:1');
  const count = caps.family === 'midjourney'
    ? 4
    : Math.max(1, Math.min(4, Number(params.n) || 1));
  const size = typeof params.size === 'string' && /^\d+x\d+$/.test(params.size)
    ? params.size
    : '2048x2048';
  const [width, height] = size.split('x').map(Number);
  const summary = [
    ratio,
    caps.showResolution ? String(params.resolution ?? caps.resolutions[0] ?? '') : null,
    caps.qualities ? QUALITY_LABELS[(params.quality as Quality) ?? caps.qualities[0]] : null,
    `${count} 张`,
  ].filter(Boolean).join(' · ');

  function commitSize(nextWidth: number, nextHeight: number) {
    const safeWidth = Number.isFinite(nextWidth) && nextWidth >= 16 ? nextWidth : width;
    const safeHeight = Number.isFinite(nextHeight) && nextHeight >= 16 ? nextHeight : height;
    onPatch({ size: normalizeStudioSizeForModel(`${safeWidth}x${safeHeight}`, model) });
  }

  return (
    <div ref={anchorRef} className="relative min-w-0">
      <button
        type="button"
        aria-label="打开图片参数"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="flex h-9 max-w-full items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Settings2 className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{summary}</span>
      </button>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        autoFocus
        direction={menuDirection}
        portalContainerRef={portalContainerRef}
        data-testid="canvas-image-settings-popover"
        className={cn(
          portalContainerRef ? 'max-h-[55vh]' : 'max-h-[70vh]',
          'w-[320px] overflow-y-auto rounded-xl border border-border bg-card p-3',
        )}
      >
        <div className="space-y-4">
          <SettingsSection title="比例">
            <div role="listbox" aria-label="选择图片比例" className="grid grid-cols-4 gap-y-1 rounded-lg bg-popover p-1">
              {caps.ratios.map(item => (
                <button
                  key={item}
                  type="button"
                  role="option"
                  aria-selected={ratio === item}
                  onClick={() => onPatch({ ratio: item }, { resetSize: true })}
                  className="flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md text-xs transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60"
                >
                  <RatioIcon ratio={item} box={16} />
                  {item}
                </button>
              ))}
            </div>
          </SettingsSection>

          {caps.showResolution && (
            <SettingsSection title="分辨率">
              <OptionTrack
                label="选择图片分辨率"
                values={caps.resolutions}
                selected={String(params.resolution ?? caps.resolutions[0])}
                onSelect={value => onPatch({ resolution: value as Resolution }, { resetSize: true })}
              />
            </SettingsSection>
          )}

          {caps.showCustomSize && (
            <SettingsSection title="自定义尺寸">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg bg-popover p-2">
                <label className="text-xs text-muted-foreground">
                  宽
                  <input
                    key={`w-${size}`}
                    type="number"
                    min={16}
                    defaultValue={width}
                    onBlur={event => commitSize(Number(event.target.value), height)}
                    className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </label>
                <span className="pt-5 text-xs text-muted-foreground">×</span>
                <label className="text-xs text-muted-foreground">
                  高
                  <input
                    key={`h-${size}`}
                    type="number"
                    min={16}
                    defaultValue={height}
                    onBlur={event => commitSize(width, Number(event.target.value))}
                    className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </label>
              </div>
            </SettingsSection>
          )}

          {caps.qualities && (
            <SettingsSection title="质量">
              <OptionTrack
                label="选择图片质量"
                values={caps.qualities}
                selected={String(params.quality ?? caps.qualities[0])}
                getLabel={value => QUALITY_LABELS[value as Quality]}
                onSelect={value => onPatch({ quality: value })}
              />
            </SettingsSection>
          )}

          {caps.supportsTransparentBackground && (
            <SettingsSection title="透明背景">
              <OptionTrack
                label="透明背景开关"
                values={['transparent', 'auto']}
                selected={params.background === 'transparent' ? 'transparent' : 'auto'}
                getLabel={value => value === 'transparent' ? '开启' : '关闭'}
                onSelect={value => onPatch({ background: value as 'auto' | 'transparent' })}
              />
            </SettingsSection>
          )}

          <SettingsSection title="生成数量">
            {caps.family === 'midjourney' ? (
              <p className="rounded-lg bg-popover px-3 py-2 text-xs text-muted-foreground">
                Midjourney 每次任务固定返回 4 张方案。
              </p>
            ) : (
              <OptionTrack
                label="选择图片生成数量"
                values={[1, 2, 3, 4]}
                selected={String(count)}
                getLabel={value => `${value} 张`}
                onSelect={value => onPatch({ n: Number(value) })}
              />
            )}
          </SettingsSection>
        </div>
      </ToolbarPopover>
    </div>
  );
}

export function CanvasTextSettings({
  supportsReasoning,
  params,
  onPatch,
  menuDirection = 'up',
  portalContainerRef,
}: {
  supportsReasoning: boolean;
  params: JobParams;
  onPatch: (patch: JobParams) => void;
} & ToolbarPopoverMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const reasoning = REASONING_OPTIONS.includes(params.reasoning_effort as (typeof REASONING_OPTIONS)[number])
    ? params.reasoning_effort as (typeof REASONING_OPTIONS)[number]
    : 'auto';
  const temperature = typeof params.temperature === 'number'
    ? String(params.temperature)
    : 'auto';
  const maxTokens = typeof params.max_tokens === 'number'
    ? String(params.max_tokens)
    : 'auto';
  const count = Math.max(1, Math.min(4, Number(params.n) || 1));
  const summary = supportsReasoning
    ? `推理 ${REASONING_LABELS[reasoning]} · ${count} 个`
    : `${TEXT_TEMPERATURE_LABELS[temperature] ?? temperature} · ${count} 个`;
  return (
    <div ref={anchorRef} className="relative min-w-0">
      <button
        type="button"
        aria-label="文本设置"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="flex h-9 max-w-full items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Settings2 className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{summary}</span>
      </button>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        autoFocus
        direction={menuDirection}
        portalContainerRef={portalContainerRef}
        data-testid="canvas-text-settings-popover"
        className="w-[320px] rounded-xl border border-border bg-card p-3"
      >
        <div className="space-y-4">
          {supportsReasoning && (
            <SettingsSection title="推理强度">
              <OptionTrack
                label="选择推理强度"
                values={REASONING_OPTIONS}
                selected={reasoning}
                getLabel={value => REASONING_LABELS[value]}
                onSelect={value => onPatch({ reasoning_effort: value })}
              />
            </SettingsSection>
          )}
          {!supportsReasoning && (
            <SettingsSection title="对话随机性">
              <OptionTrack
                label="选择对话随机性"
                values={TEXT_TEMPERATURE_OPTIONS}
                selected={temperature}
                getLabel={value => TEXT_TEMPERATURE_LABELS[String(value)] ?? String(value)}
                onSelect={value => onPatch({
                  temperature: value === 'auto' ? undefined : Number(value),
                })}
              />
            </SettingsSection>
          )}
          <SettingsSection title="最大输出长度">
            <OptionTrack
              label="选择最大输出长度"
              values={TEXT_MAX_TOKEN_OPTIONS}
              selected={maxTokens}
              getLabel={value => value === 'auto' ? '自动' : String(value)}
              onSelect={value => onPatch({
                max_tokens: value === 'auto' ? undefined : Number(value),
              })}
            />
          </SettingsSection>
          <SettingsSection title="生成数量">
            <OptionTrack
              label="选择文本生成数量"
              values={[1, 2, 3, 4]}
              selected={String(count)}
              getLabel={value => `${value} 个`}
              onSelect={value => onPatch({ n: Number(value) })}
            />
          </SettingsSection>
        </div>
      </ToolbarPopover>
    </div>
  );
}

export function CanvasAudioSettings({
  params,
  onPatch,
  menuDirection = 'up',
  portalContainerRef,
}: {
  params: JobParams;
  onPatch: (patch: JobParams) => void;
} & ToolbarPopoverMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const voice = normalizeAudioVoice(params.voice);
  const format = normalizeAudioFormat(params.response_format);
  const speed = normalizeAudioSpeed(params.speed);
  const instructions = String(params.instructions ?? '');
  const [speedDraft, setSpeedDraft] = useState(String(speed));
  const [instructionsDraft, setInstructionsDraft] = useState(instructions);
  const committedRef = useRef({ speed, instructions });

  useEffect(() => {
    committedRef.current.speed = speed;
    setSpeedDraft(String(speed));
  }, [speed]);
  useEffect(() => {
    committedRef.current.instructions = instructions;
    setInstructionsDraft(instructions);
  }, [instructions]);

  function commitDrafts(fields: { speed: boolean; instructions: boolean }) {
    const patch: JobParams = {};
    if (fields.speed) {
      const normalizedSpeed = normalizeAudioSpeed(speedDraft);
      setSpeedDraft(String(normalizedSpeed));
      if (normalizedSpeed !== committedRef.current.speed) {
        patch.speed = normalizedSpeed;
        committedRef.current.speed = normalizedSpeed;
      }
    }
    if (fields.instructions) {
      const normalizedInstructions = instructionsDraft.trim();
      setInstructionsDraft(normalizedInstructions);
      if (normalizedInstructions !== committedRef.current.instructions) {
        patch.instructions = normalizedInstructions || undefined;
        committedRef.current.instructions = normalizedInstructions;
      }
    }
    if (Object.keys(patch).length) onPatch(patch);
  }

  function commitSpeed() {
    commitDrafts({ speed: true, instructions: false });
  }

  function commitInstructions() {
    commitDrafts({ speed: false, instructions: true });
  }

  function close() {
    commitDrafts({ speed: true, instructions: true });
    setOpen(false);
  }

  function toggle() {
    if (open) close();
    else setOpen(true);
  }

  return (
    <div ref={anchorRef} className="relative min-w-0">
      <button
        type="button"
        aria-label="音频生成设置"
        aria-expanded={open}
        onClick={toggle}
        className="flex h-9 max-w-full items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Settings2 className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {audioVoiceLabel(voice)} · {audioFormatLabel(format)} · {audioSpeedLabel(speed)}
        </span>
      </button>
      <ToolbarPopover
        open={open}
        onClose={close}
        anchorRef={anchorRef}
        autoFocus
        direction={menuDirection}
        portalContainerRef={portalContainerRef}
        data-testid="canvas-audio-settings-popover"
        className={cn(
          portalContainerRef ? 'max-h-[55vh]' : 'max-h-[70vh]',
          'w-[356px] overflow-y-auto rounded-xl border border-border bg-card p-3',
        )}
      >
        <div className="space-y-4">
          <SettingsSection title="音色">
            <OptionGrid
              label="选择音色"
              values={AUDIO_VOICE_OPTIONS}
              selected={voice}
              onSelect={value => onPatch({ voice: value })}
            />
          </SettingsSection>
          <SettingsSection title="格式">
            <OptionGrid
              label="选择音频格式"
              values={AUDIO_FORMAT_OPTIONS}
              selected={format}
              onSelect={value => onPatch({ response_format: value })}
            />
          </SettingsSection>
          <SettingsSection title="语速">
            <OptionTrack
              label="选择语速预设"
              values={AUDIO_SPEED_PRESETS}
              selected={String(speed)}
              getLabel={value => audioSpeedLabel(value)}
              onSelect={value => onPatch({ speed: value })}
            />
            <input
              type="number"
              aria-label="自定义语速"
              min={0.25}
              max={4}
              step={0.05}
              value={speedDraft}
              onChange={event => setSpeedDraft(event.target.value)}
              onBlur={commitSpeed}
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className="mt-2 h-9 w-full rounded-md border border-input bg-transparent px-3 text-center text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </SettingsSection>
          <SettingsSection title="朗读指令">
            <textarea
              aria-label="朗读指令"
              rows={3}
              value={instructionsDraft}
              placeholder="例如：语气温柔、语速平稳，句尾稍作停顿"
              onChange={event => setInstructionsDraft(event.target.value)}
              onBlur={commitInstructions}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            />
          </SettingsSection>
        </div>
      </ToolbarPopover>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="px-1 py-1 text-xs text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

function OptionTrack<T extends string | number>({
  label,
  values,
  selected,
  getLabel = String,
  onSelect,
}: {
  label: string;
  values: readonly T[];
  selected: string;
  getLabel?: (value: T) => string;
  onSelect: (value: T) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={label}
      className="grid auto-cols-fr grid-flow-col rounded-lg bg-popover p-0.5"
    >
      {values.map(value => (
        <button
          key={value}
          type="button"
          role="option"
          aria-selected={selected === String(value)}
          onClick={() => {
            if (selected !== String(value)) onSelect(value);
          }}
          className="h-8 rounded-md px-2 text-center text-sm transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60"
        >
          {getLabel(value)}
        </button>
      ))}
    </div>
  );
}

function OptionGrid<T extends string>({
  label,
  values,
  selected,
  onSelect,
}: {
  label: string;
  values: ReadonlyArray<{ value: T; label: string }>;
  selected: string;
  onSelect: (value: T) => void;
}) {
  return (
    <div role="listbox" aria-label={label} className="grid grid-cols-3 gap-y-1 rounded-lg bg-popover p-1">
      {values.map(item => (
        <button
          key={item.value}
          type="button"
          role="option"
          aria-selected={selected === item.value}
          onClick={() => {
            if (selected !== item.value) onSelect(item.value);
          }}
          className="h-8 rounded-md px-2 text-center text-sm transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
