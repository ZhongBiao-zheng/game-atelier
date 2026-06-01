import { type ButtonHTMLAttributes, type KeyboardEvent, useCallback, useEffect, useState } from 'react';
import { ArrowUp, Box, ImageIcon, Images, Square, Building2, Link2 } from 'lucide-react';
import type { KeyView } from '@/api/keys';
import { computeStudioPixelSize, normalizeStudioPixelSizeForProvider } from '@/lib/studioSize';

interface Props {
  onSubmit: (prompt: string) => void | Promise<void>;
  disabled?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  providers?: KeyView[];
  providerAlias?: string;
  model?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  count?: number;
  onProviderChange?: (alias: string) => void;
  onModelChange?: (model: string) => void;
  onRatioChange?: (ratio: string) => void;
  onResolutionChange?: (resolution: '2K' | '4K') => void;
  onCountChange?: (count: number) => void;
  onCustomSizeChange?: (w: number, h: number) => void;
  /** When set, overrides localW/localH after the ratio/resolution effect; keyed to ensure re-runs. */
  sizeOverride?: { key: number; w: number; h: number };
  menuDirection?: 'up' | 'down';
}

const SIDE_RATIOS = ['4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  seedream: '火山引擎',
  midjourney: 'Midjourney',
  nano_banana: 'Nano Banana',
  lovart: 'Lovart',
};

function providerName(provider?: KeyView) {
  if (!provider) return '未配置厂商';
  return PROVIDER_LABELS[provider.provider] ?? provider.alias;
}

export function PromptInput({
  onSubmit,
  disabled,
  value,
  onValueChange,
  providers = [],
  providerAlias,
  model,
  ratio = '1:1',
  resolution = '2K',
  count = 1,
  onProviderChange,
  onModelChange,
  onRatioChange,
  onResolutionChange,
  onCountChange,
  onCustomSizeChange,
  sizeOverride,
  menuDirection = 'up',
}: Props) {
  const [internalText, setInternalText] = useState('');
  const text = value ?? internalText;
  const setText = onValueChange ?? setInternalText;
  const [openPanel, setOpenPanel] = useState<'provider' | 'model' | 'size' | 'count' | null>(null);
  const provider = providers.find((item) => item.alias === providerAlias) ?? providers[0];
  const providerDisplayName = providerName(provider);
  const models = provider?.models ?? [];
  const selectedModel = models.find((item) => item.id === model) ?? models[0];
  const initSize = computeStudioPixelSize(ratio, resolution, provider?.provider);
  const [localW, setLocalW] = useState(initSize.w);
  const [localH, setLocalH] = useState(initSize.h);
  const [sizeLocked, setSizeLocked] = useState(true);
  const canSubmit = Boolean(provider && selectedModel && text.trim() && !disabled);
  const panelPosition = menuDirection === 'down'
    ? 'top-full mt-3'
    : 'bottom-full mb-3';
  const minPx = 1;

  useEffect(() => {
    const { w, h } = computeStudioPixelSize(ratio, resolution, provider?.provider);
    const normalized = normalizeStudioPixelSizeForProvider({ w, h }, provider?.provider);
    setLocalW(normalized.w);
    setLocalH(normalized.h);
    onCustomSizeChange?.(normalized.w, normalized.h);
  }, [ratio, resolution, provider?.provider, onCustomSizeChange]);

  // Runs after the ratio/resolution effect so it wins — used by reEdit to restore custom sizes.
  useEffect(() => {
    if (!sizeOverride) return;
    setLocalW(sizeOverride.w);
    setLocalH(sizeOverride.h);
    onCustomSizeChange?.(sizeOverride.w, sizeOverride.h);
  }, [sizeOverride, onCustomSizeChange]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled || !provider || !selectedModel) return;
    onSubmit(trimmed);
  }, [text, disabled, provider, selectedModel, onSubmit]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  function handleRatioSelect(newRatio: string) {
    onRatioChange?.(newRatio);
    const { w, h } = computeStudioPixelSize(newRatio, resolution, provider?.provider);
    const normalized = normalizeStudioPixelSizeForProvider({ w, h }, provider?.provider);
    setLocalW(normalized.w);
    setLocalH(normalized.h);
    onCustomSizeChange?.(normalized.w, normalized.h);
  }

  function handleResolutionSelect(newResolution: '2K' | '4K') {
    onResolutionChange?.(newResolution);
    const { w, h } = computeStudioPixelSize(ratio, newResolution, provider?.provider);
    const normalized = normalizeStudioPixelSizeForProvider({ w, h }, provider?.provider);
    setLocalW(normalized.w);
    setLocalH(normalized.h);
    onCustomSizeChange?.(normalized.w, normalized.h);
  }

  function handleWChange(raw: string) {
    const newW = Math.max(minPx, parseInt(raw, 10) || minPx);
    setLocalW(newW);
    if (sizeLocked) {
      const [a, b] = ratio.split(':').map(Number);
      const newH = a > 0 ? Math.max(minPx, Math.round((newW * b) / a)) : localH;
      const normalized = normalizeStudioPixelSizeForProvider({ w: newW, h: newH }, provider?.provider);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    } else {
      const normalized = normalizeStudioPixelSizeForProvider({ w: newW, h: localH }, provider?.provider);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    }
  }

  function handleHChange(raw: string) {
    const newH = Math.max(minPx, parseInt(raw, 10) || minPx);
    setLocalH(newH);
    if (sizeLocked) {
      const [a, b] = ratio.split(':').map(Number);
      const newW = b > 0 ? Math.max(minPx, Math.round((newH * a) / b)) : localW;
      const normalized = normalizeStudioPixelSizeForProvider({ w: newW, h: newH }, provider?.provider);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    } else {
      const normalized = normalizeStudioPixelSizeForProvider({ w: localW, h: newH }, provider?.provider);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    }
  }

  function handleToggleLock() {
    const next = !sizeLocked;
    setSizeLocked(next);
    if (next) {
      const { w, h } = computeStudioPixelSize(ratio, resolution, provider?.provider);
      const normalized = normalizeStudioPixelSizeForProvider({ w, h }, provider?.provider);
      setLocalW(normalized.w);
      setLocalH(normalized.h);
      onCustomSizeChange?.(normalized.w, normalized.h);
    }
  }

  return (
    <div
      data-testid="studio-prompt-shell"
      className="bg-card/80 rounded-[2rem] border border-input/80 pt-[14px] px-4 pb-4 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl min-h-[174px] h-auto flex flex-col gap-3"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="开始一段灵感对话..."
        className="flex-1 min-h-0 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none rounded-md px-2"
        aria-label="生图 prompt"
      />
      <div className="flex flex-wrap justify-between items-center gap-3 shrink-0">
        <div className="flex min-w-0 flex-wrap gap-2">
          <ControlButton active aria-label="图片生成">
            <ImageIcon size={14} aria-hidden /> 图片生成
          </ControlButton>

          <div data-testid="provider-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'provider'}
              aria-label="选择厂商"
              onClick={() => setOpenPanel(openPanel === 'provider' ? null : 'provider')}
              disabled={providers.length === 0}
            >
              <Building2 size={14} aria-hidden /> {providerDisplayName}
            </ControlButton>
            {openPanel === 'provider' && (
              <div role="listbox" aria-label="选择厂商列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-secondary p-2 shadow-2xl`}>
                <div className="px-3 py-2 text-sm text-muted-foreground">选择厂商</div>
                {providers.map((item) => (
                  <button
                    key={item.alias}
                    type="button"
                    role="option"
                    aria-selected={item.alias === provider?.alias}
                    onClick={() => {
                      onProviderChange?.(item.alias);
                      onModelChange?.(item.models[0]?.id ?? '');
                      setOpenPanel(null);
                    }}
                    className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-card aria-selected:bg-card aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    <Building2 size={20} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{providerName(item)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.alias} · {item.models.length} models</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div data-testid="model-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'model'}
              aria-label="选择模型"
              onClick={() => setOpenPanel(openPanel === 'model' ? null : 'model')}
              disabled={!provider || models.length === 0}
            >
              <Box size={14} aria-hidden /> {selectedModel ? selectedModel.name : '未配置模型'}
            </ControlButton>
            {openPanel === 'model' && (
              <div role="listbox" aria-label="选择模型列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-secondary p-2 shadow-2xl`}>
                <div className="px-3 py-2 text-sm text-muted-foreground">选择模型：{providerDisplayName}</div>
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selectedModel?.id === item.id}
                    onClick={() => {
                      onModelChange?.(item.id);
                      setOpenPanel(null);
                    }}
                    className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-card aria-selected:bg-card aria-selected:ring-inset aria-selected:ring-1 aria-selected:ring-primary/50"
                  >
                    <Box size={22} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.id}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div data-testid="size-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'size'}
              aria-label="选择比例和分辨率"
              onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
            >
              <Square size={14} aria-hidden /> {localW}:{localH} <span className="text-muted-foreground">|</span> {resolution === '2K' ? '高清 2K' : '超清 4K'}
            </ControlButton>
            {openPanel === 'size' && (
              <div data-testid="size-popover" className={`absolute left-0 ${panelPosition} z-20 w-[320px] max-h-[70vh] overflow-y-auto rounded-2xl bg-secondary p-3 shadow-2xl ring-1 ring-border`}>
                <div className="space-y-4">
                  <section className="w-[296px]">
                    <div className="py-1 px-1 text-xs text-muted-foreground">比例</div>
                    <div
                      role="listbox"
                      aria-label="选择比例"
                      className="grid h-[98px] w-[296px] grid-cols-[56px_1fr] gap-2 rounded-2xl bg-card p-1"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={ratio === '1:1'}
                        onClick={() => handleRatioSelect('1:1')}
                        className="flex h-[90px] w-[56px] flex-col items-center justify-center gap-2 rounded-xl text-sm hover:bg-secondary aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                      >
                        <RatioIcon ratio="1:1" box={28} />
                        <span>1:1</span>
                      </button>
                      <div data-testid="side-ratio-grid" className="grid min-w-0 grid-cols-4 grid-rows-2 gap-1">
                        {SIDE_RATIOS.map((item) => (
                          <button
                            key={item}
                            type="button"
                            role="option"
                            aria-selected={ratio === item}
                            onClick={() => handleRatioSelect(item)}
                            className="flex h-[43px] w-full flex-col items-center justify-center gap-0.5 rounded-lg text-sm hover:bg-secondary aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                          >
                            <RatioIcon ratio={item} box={18} />
                            <span>{item}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>

                  <section className="w-[296px]">
                    <div className="py-1 px-1 text-xs text-muted-foreground">分辨率</div>
                    <div role="listbox" aria-label="选择分辨率" className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-card p-0.5">
                      {(['2K', '4K'] as const).map((item) => (
                        <button
                          key={item}
                          type="button"
                          role="option"
                          aria-selected={resolution === item}
                          onClick={() => handleResolutionSelect(item)}
                          className="h-8 rounded-xl text-center text-sm hover:bg-secondary aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60 transition-colors"
                        >
                          {item === '2K' ? '高清 2K' : '超清 4K'}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="w-[296px]">
                    <div className="py-1 px-1 text-xs text-muted-foreground">尺寸</div>
                    <div className="flex w-[296px] items-center gap-2">
                      <div className="flex min-w-0 flex-1 items-center h-[34px] rounded-xl bg-card px-4 py-[10px]">
                        <span className="shrink-0 text-[12px] text-muted-foreground">W</span>
                        <input
                          type="number"
                          aria-label="输出宽度"
                          value={localW}
                          min={minPx}
                          onChange={(e) => handleWChange(e.target.value)}
                          className="min-w-0 flex-1 bg-transparent text-[12px] tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none pt-[7px] pb-[7px] pl-2 pr-0"
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={sizeLocked ? '解除比例锁定' : '锁定比例'}
                        title={sizeLocked ? '解除比例锁定' : '锁定比例'}
                        onClick={handleToggleLock}
                        className={`grid size-6 shrink-0 place-items-center rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary ${sizeLocked ? 'text-primary' : 'text-muted-foreground'}`}
                      >
                        <Link2 size={15} aria-hidden />
                      </button>
                      <div className="flex min-w-0 flex-1 items-center h-[34px] rounded-xl bg-card px-4 py-[10px]">
                        <span className="shrink-0 text-[12px] text-muted-foreground">H</span>
                        <input
                          type="number"
                          aria-label="输出高度"
                          value={localH}
                          min={minPx}
                          onChange={(e) => handleHChange(e.target.value)}
                          className="min-w-0 flex-1 bg-transparent text-[12px] tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none pt-[7px] pb-[7px] pl-2 pr-0"
                        />
                      </div>
                      <span className="shrink-0 text-[12px] text-muted-foreground">PX</span>
                    </div>
                  </section>
                </div>
              </div>
            )}
          </div>

          <div data-testid="count-control-wrap" className="relative">
            <ControlButton
              active={openPanel === 'count'}
              aria-label="选择出图数量"
              onClick={() => setOpenPanel(openPanel === 'count' ? null : 'count')}
            >
              <Images size={14} aria-hidden /> {count} 张
            </ControlButton>
            {openPanel === 'count' && (
              <div role="listbox" aria-label="选择出图数量列表" className={`absolute left-0 ${panelPosition} z-20 flex gap-2 rounded-2xl border border-border bg-secondary p-3 shadow-2xl`}>
                {[1, 2, 3, 4].map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={count === item}
                    aria-label={String(item)}
                    onClick={() => {
                      onCountChange?.(item);
                      setOpenPanel(null);
                    }}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background/30 text-sm font-medium transition-colors hover:bg-card aria-selected:bg-secondary aria-selected:border-primary/60 aria-selected:ring-1 aria-selected:ring-primary/60"
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          aria-label="提交生成"
          title="提交 (⌘↵)"
          className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background transition-colors"
        >
          <ArrowUp size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function ControlButton({
  active,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex min-w-0 max-w-full h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-border bg-secondary text-foreground'
          : 'border-border bg-background/30 text-foreground hover:bg-secondary'
      } ${className}`}
      {...props}
    />
  );
}

function RatioIcon({ ratio, box = 20 }: { ratio: string; box?: number }) {
  const [a, b] = ratio.split(':').map(Number);
  let w: number, h: number;
  if (a >= b) {
    w = box;
    h = Math.max(Math.round((b / a) * box), 4);
  } else {
    h = box;
    w = Math.max(Math.round((a / b) * box), 4);
  }
  const x = (box - w) / 2;
  const y = (box - h) / 2;
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="none">
      <rect x={x} y={y} width={w} height={h} rx="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
