import { useRef, useState, type ReactNode } from 'react';
import { Boxes, Check, Images, Settings2 } from 'lucide-react';

import type { KeyView } from '@/api/keys';
import { RatioIcon } from '@/components/studio/RatioIcon';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { QUALITY_LABELS, type ImageControlCaps, type Quality } from '@/lib/imageControlCaps';
import { normalizeStudioSizeForModel, type Resolution } from '@/lib/studioSize';
import type { JobParams } from '@/schema/jobs';

export interface CanvasModelChoice {
  key: KeyView;
  model: KeyView['models'][number];
}

export function CanvasModelPicker({
  choices,
  alias,
  model,
  onSelect,
}: {
  choices: CanvasModelChoice[];
  alias: string | null;
  model: string;
  onSelect: (choice: CanvasModelChoice) => void;
}) {
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
        direction="up"
        data-testid="canvas-model-popover"
        className="max-h-[60vh] w-[320px] overflow-y-auto rounded-xl border border-border bg-card p-3"
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
                        className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60"
                      >
                        <span className="min-w-0 flex-1 truncate">{choice.model.name || choice.model.id}</span>
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
}: {
  caps: ImageControlCaps;
  model: string;
  params: JobParams;
  onPatch: (patch: JobParams, options?: { resetSize?: boolean }) => void;
}) {
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
        direction="up"
        data-testid="canvas-image-settings-popover"
        className="max-h-[70vh] w-[320px] overflow-y-auto rounded-xl border border-border bg-card p-3"
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

export function CanvasCountSettings({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        aria-label="文本生成设置"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Images className="size-3.5" aria-hidden="true" /> {value} 个候选
      </button>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        autoFocus
        direction="up"
        className="w-[240px] rounded-xl border border-border bg-card p-3"
      >
        <SettingsSection title="生成数量">
          <OptionTrack
            label="选择文本生成数量"
            values={[1, 2, 3, 4]}
            selected={String(value)}
            getLabel={item => `${item} 个`}
            onSelect={item => {
              onChange(Number(item));
              setOpen(false);
              anchorRef.current?.querySelector<HTMLElement>('button')?.focus();
            }}
          />
        </SettingsSection>
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
