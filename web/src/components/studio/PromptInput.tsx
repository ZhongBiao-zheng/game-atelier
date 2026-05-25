import { type KeyboardEvent, useCallback, useState, useEffect } from 'react';
import { ArrowUp } from 'lucide-react';

interface Props {
  onSubmit: (prompt: string) => void | Promise<void>;
  disabled?: boolean;
  initialValue?: string;
}

export function PromptInput({ onSubmit, disabled, initialValue = '' }: Props) {
  const [text, setText] = useState(initialValue);

  useEffect(() => {
    if (initialValue) setText(initialValue);
  }, [initialValue]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
  }, [text, disabled, onSubmit]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="bg-card rounded-lg border border-input p-4 space-y-3 max-w-3xl mx-auto">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="你好，想创作什么？描述你想生成的图片…"
        rows={3}
        className="w-full bg-transparent text-base text-foreground placeholder:italic placeholder:text-muted-foreground resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md p-2"
        aria-label="生图 prompt"
      />
      <div className="flex justify-between items-center">
        <div className="text-xs text-muted-foreground">
          图片生成 · GPT Image 2 · 1024×1024 · default key
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
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
