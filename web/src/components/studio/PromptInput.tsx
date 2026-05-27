import { type ButtonHTMLAttributes, type KeyboardEvent, useCallback, useState } from 'react';
import { ArrowUp, Box, ImageIcon, Square, Building2, Link2 } from 'lucide-react';
import type { KeyView } from '@/api/keys';
import { computeStudioPixelSize } from '@/lib/studioSize';

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
  onProviderChange?: (alias: string) => void;
  onModelChange?: (model: string) => void;
  onRatioChange?: (ratio: string) => void;
  onResolutionChange?: (resolution: '2K' | '4K') => void;
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
  onProviderChange,
  onModelChange,
  onRatioChange,
  onResolutionChange,
  menuDirection = 'up',
}: Props) {
  const [internalText, setInternalText] = useState('');
  const text = value ?? internalText;
  const setText = onValueChange ?? setInternalText;
  const [openPanel, setOpenPanel] = useState<'provider' | 'model' | 'size' | null>(null);
  const provider = providers.find((item) => item.alias === providerAlias) ?? providers[0];
  const providerDisplayName = providerName(provider);
  const models = provider?.models ?? [];
  const selectedModel = models.find((item) => item.id === model) ?? models[0];
  const canSubmit = Boolean(provider && selectedModel && text.trim() && !disabled);
  const panelPosition = menuDirection === 'down'
    ? 'top-full mt-3'
    : 'bottom-full mb-3';

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled || !provider || !selectedModel) return;
    onSubmit(trimmed);
    setText('');
  }, [text, disabled, provider, selectedModel, onSubmit]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      data-testid="studio-prompt-shell"
      className="bg-card/80 rounded-[2rem] border border-input/80 pt-[14px] px-4 pb-4 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl h-[174px] flex flex-col gap-3"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="开始一段灵感对话..."
        className="flex-1 min-h-0 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none rounded-md px-2"
        aria-label="生图 prompt"
      />
      <div className="flex justify-between items-center gap-4 shrink-0">
        <div className="flex flex-wrap gap-2">
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
              <div role="listbox" aria-label="选择厂商列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}>
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
                    className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
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
              <div role="listbox" aria-label="选择模型列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}>
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
                    className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
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
              <Square size={14} aria-hidden /> {ratio} <span className="text-muted-foreground">|</span> {resolution === '2K' ? '高清 2K' : '超清 4K'}
            </ControlButton>
            {openPanel === 'size' && (
              <div data-testid="size-popover" className={`absolute left-0 ${panelPosition} z-20 w-[620px] max-w-[calc(100vw-32px)] max-h-[70vh] overflow-y-auto rounded-2xl border border-border bg-popover shadow-2xl`}>
                <div className="p-5 space-y-4">
                  <section>
                    <div className="mb-2 text-sm font-semibold text-muted-foreground">比例</div>
                    <div
                      role="listbox"
                      aria-label="选择比例"
                      className="grid h-[196px] grid-cols-[112px_1fr] gap-2 rounded-2xl bg-secondary p-2"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={ratio === '1:1'}
                        onClick={() => onRatioChange?.('1:1')}
                        className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-xl text-base hover:bg-card aria-selected:bg-card transition-colors"
                      >
                        <RatioIcon ratio="1:1" box={38} />
                        <span>1:1</span>
                      </button>
                      <div data-testid="side-ratio-grid" className="grid grid-cols-4 grid-rows-2 gap-1.5">
                        {SIDE_RATIOS.map((item) => (
                          <button
                            key={item}
                            type="button"
                            role="option"
                            aria-selected={ratio === item}
                            onClick={() => onRatioChange?.(item)}
                            className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg text-sm hover:bg-card aria-selected:bg-card transition-colors"
                          >
                            <RatioIcon ratio={item} box={24} />
                            <span>{item}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 text-sm font-semibold text-muted-foreground">分辨率</div>
                    <div role="listbox" aria-label="选择分辨率" className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-secondary p-0.5">
                      {(['2K', '4K'] as const).map((item) => (
                        <button
                          key={item}
                          type="button"
                          role="option"
                          aria-selected={resolution === item}
                          onClick={() => onResolutionChange?.(item)}
                          className="h-8 rounded-xl text-center text-sm hover:bg-card aria-selected:bg-card transition-colors"
                        >
                          {item === '2K' ? '高清 2K' : '超清 4K'}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 text-sm font-semibold text-muted-foreground">尺寸</div>
                    <div className="flex h-9 items-center gap-2 rounded-2xl bg-secondary p-0.5">
                      <div aria-label="输出宽度" className="flex h-8 flex-1 items-center gap-2 rounded-xl px-3 text-sm">
                        <span className="font-medium text-muted-foreground">W</span>
                        <span className="flex-1 text-center tabular-nums">{computeStudioPixelSize(ratio, resolution, provider?.provider).w}</span>
                      </div>
                      <Link2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                      <div aria-label="输出高度" className="flex h-8 flex-1 items-center gap-2 rounded-xl px-3 text-sm">
                        <span className="font-medium text-muted-foreground">H</span>
                        <span className="flex-1 text-center tabular-nums">{computeStudioPixelSize(ratio, resolution, provider?.provider).h}</span>
                      </div>
                      <span className="shrink-0 pr-3 text-sm text-muted-foreground">PX</span>
                    </div>
                  </section>
                </div>
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
      className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
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
