import { type ButtonHTMLAttributes, type KeyboardEvent, useCallback, useState, useEffect } from 'react';
import { ArrowUp, Box, ImageIcon, Square, Building2 } from 'lucide-react';
import type { KeyView } from '@/api/keys';

interface Props {
  onSubmit: (prompt: string) => void | Promise<void>;
  disabled?: boolean;
  initialValue?: string;
  providers?: KeyView[];
  providerAlias?: string;
  model?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  onProviderChange?: (alias: string) => void;
  onModelChange?: (model: string) => void;
  onRatioChange?: (ratio: string) => void;
  onResolutionChange?: (resolution: '2K' | '4K') => void;
}

const RATIOS = ['智能', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];

export function PromptInput({
  onSubmit,
  disabled,
  initialValue = '',
  providers = [],
  providerAlias,
  model,
  ratio = '1:1',
  resolution = '2K',
  onProviderChange,
  onModelChange,
  onRatioChange,
  onResolutionChange,
}: Props) {
  const [text, setText] = useState(initialValue);
  const [openPanel, setOpenPanel] = useState<'provider' | 'model' | 'size' | null>(null);
  const provider = providers.find((item) => item.alias === providerAlias) ?? providers[0];
  const models = provider?.models ?? [];
  const selectedModel = models.find((item) => item.id === model) ?? models[0];
  const canSubmit = Boolean(provider && selectedModel && text.trim() && !disabled);

  useEffect(() => {
    if (initialValue) setText(initialValue);
  }, [initialValue]);

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
    <div className="bg-card/80 rounded-[2rem] border border-input/80 p-8 space-y-6 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="开始一段灵感对话..."
        rows={5}
        className="w-full bg-transparent text-2xl text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md p-2"
        aria-label="生图 prompt"
      />
      <div className="flex justify-between items-center gap-4">
        <div className="flex flex-wrap gap-2">
          <ControlButton active aria-label="图片生成">
            <ImageIcon size={18} aria-hidden /> 图片生成
          </ControlButton>
          <ControlButton
            aria-label="选择厂商"
            onClick={() => setOpenPanel(openPanel === 'provider' ? null : 'provider')}
            disabled={providers.length === 0}
          >
            <Building2 size={18} aria-hidden /> {provider ? provider.alias : '未配置厂商'}
          </ControlButton>
          <ControlButton
            aria-label="选择模型"
            onClick={() => setOpenPanel(openPanel === 'model' ? null : 'model')}
            disabled={!provider || models.length === 0}
          >
            <Box size={18} aria-hidden /> {selectedModel ? selectedModel.name : '未配置模型'}
          </ControlButton>
          <ControlButton
            aria-label="选择比例和分辨率"
            onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
          >
            <Square size={18} aria-hidden /> {ratio} <span className="text-muted-foreground">|</span> 高清 {resolution}
          </ControlButton>
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
      {openPanel === 'provider' && (
        <div role="listbox" aria-label="选择厂商列表" className="absolute left-40 right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-2 shadow-2xl">
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
              className="w-full flex items-center gap-4 rounded-lg px-4 py-4 text-left hover:bg-secondary aria-selected:bg-secondary"
            >
              <Building2 size={24} aria-hidden />
              <span>
                <span className="block text-base font-medium">{item.alias}</span>
                <span className="block text-sm text-muted-foreground">{item.provider} · {item.models.length} models</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {openPanel === 'model' && (
        <div role="listbox" aria-label="选择模型列表" className="absolute left-64 right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-2 shadow-2xl">
          <div className="px-3 py-2 text-sm text-muted-foreground">选择模型：{provider?.alias}</div>
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
              className="w-full flex items-center gap-4 rounded-lg px-4 py-4 text-left hover:bg-secondary aria-selected:bg-secondary"
            >
              <Box size={28} aria-hidden />
              <span>
                <span className="block text-lg font-medium">{item.name}</span>
                <span className="block text-sm text-muted-foreground">{item.id}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {openPanel === 'size' && (
        <div className="absolute left-96 right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-8 shadow-2xl space-y-8">
          <section>
            <div className="mb-3 text-sm text-muted-foreground">选择比例</div>
            <div role="listbox" aria-label="选择比例" className="grid grid-cols-9 gap-1 rounded-2xl bg-secondary p-2">
              {RATIOS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="option"
                  aria-selected={ratio === item}
                  onClick={() => onRatioChange?.(item === '智能' ? '1:1' : item)}
                  className="rounded-lg px-2 py-3 text-center hover:bg-card aria-selected:bg-card"
                >
                  {item}
                </button>
              ))}
            </div>
          </section>
          <section>
            <div className="mb-3 text-sm text-muted-foreground">选择分辨率</div>
            <div role="listbox" aria-label="选择分辨率" className="grid grid-cols-2 gap-1 rounded-2xl bg-secondary p-1">
              {(['2K', '4K'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="option"
                  aria-selected={resolution === item}
                  onClick={() => onResolutionChange?.(item)}
                  className="rounded-lg px-4 py-4 text-lg hover:bg-card aria-selected:bg-card"
                >
                  {item === '2K' ? '高清 2K' : '超清 4K ✦'}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
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
      className={`inline-flex h-12 items-center gap-2 rounded-xl border px-4 text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border bg-background/30 text-foreground hover:bg-secondary'
      } ${className}`}
      {...props}
    />
  );
}
