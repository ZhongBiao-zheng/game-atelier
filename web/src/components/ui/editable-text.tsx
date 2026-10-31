import * as React from 'react';

import { cn } from '@/lib/utils';
import { FOCUS_RING } from './focus';
import { Input } from './input';

/** 按下到松开移动超过这个距离算拖动（画布分组名同时是拖动把手），不进入编辑。 */
const DRAG_THRESHOLD = 4;

const SIZES = {
  sm: 'h-7 px-1.5 text-xs',
  default: 'h-9 px-2 text-sm',
  lg: 'h-9 px-2 text-base',
} as const;

export interface EditableTextHandle {
  /** 从菜单等其他入口进入编辑 */
  edit: () => void;
}

export interface EditableTextProps {
  value: string;
  /** 返回 false 表示保存未成功、留在编辑态；抛错时把错误信息显示在输入框下方 */
  onSave: (next: string) => void | boolean | Promise<void | boolean>;
  /** 展示态按钮的读屏名称 */
  triggerLabel: string;
  /** 编辑态输入框的读屏名称，默认同 triggerLabel */
  inputLabel?: string;
  maxLength?: number;
  size?: keyof typeof SIZES;
  disabled?: boolean;
  /** 加在外层；字重、颜色从这里继承到展示态与编辑态 */
  className?: string;
}

/**
 * 标题就地重命名：单击（或 Enter / 空格 / F2）进入编辑；Enter 或失焦保存，Esc 取消。
 * 展示态与编辑态同高同内边距，切换时文字不移位。切应用、切标签页造成的失焦不算编辑结束；
 * 输入法组合中按 Enter 只上屏不保存。
 */
export const EditableText = React.forwardRef<EditableTextHandle, EditableTextProps>(function EditableText({
  value, onSave, triggerLabel, inputLabel, maxLength, size = 'default', disabled = false, className,
}, ref) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const pointerStart = React.useRef<{ x: number; y: number } | null>(null);
  const settled = React.useRef(false);
  const composing = React.useRef(false);
  const blurredWhileComposing = React.useRef(false);
  const editing = draft !== null;

  const begin = React.useCallback(() => {
    if (disabled) return;
    settled.current = false;
    setError(null);
    setDraft(value);
  }, [disabled, value]);
  React.useImperativeHandle(ref, () => ({ edit: begin }), [begin]);

  React.useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function close(refocus: boolean) {
    settled.current = true;
    setDraft(null);
    setError(null);
    if (refocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function commit(refocus: boolean, text = draft) {
    if (text === null || settled.current || busy) return;
    const next = text.trim();
    if (!next || next === value) { close(refocus); return; }
    setBusy(true);
    try {
      if (await onSave(next) === false) return;
      close(refocus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const sizeClass = SIZES[size];
  return (
    <span className={cn('inline-grid min-w-0 max-w-full', className)}>
      {editing ? (
        <>
          {/* 隐藏的同字号文本撑开格子，输入框宽度跟着名字走 */}
          <span aria-hidden="true" className={cn('invisible col-start-1 row-start-1 whitespace-pre border', sizeClass)}>{draft || ' '}</span>
          <Input
            ref={inputRef}
            size={1}
            value={draft}
            maxLength={maxLength}
            readOnly={busy}
            aria-label={inputLabel ?? triggerLabel}
            aria-invalid={error ? true : undefined}
            className={cn('nodrag nowheel nopan col-start-1 row-start-1 min-w-24', sizeClass)}
            onChange={event => setDraft(event.target.value)}
            onPointerDown={event => event.stopPropagation()}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={event => {
              composing.current = false;
              if (!blurredWhileComposing.current) return;
              blurredWhileComposing.current = false;
              void commit(false, event.currentTarget.value);
            }}
            onBlur={() => {
              if (!window.document.hasFocus()) return;
              if (composing.current) { blurredWhileComposing.current = true; return; }
              void commit(false);
            }}
            onKeyDown={event => {
              event.stopPropagation();
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter') { event.preventDefault(); void commit(true); }
              else if (event.key === 'Escape') { event.preventDefault(); close(true); }
            }}
          />
          {error && <span role="alert" className="col-start-1 row-start-2 pt-1 text-xs text-destructive">{error}</span>}
        </>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-label={triggerLabel}
          className={cn(
            'col-start-1 row-start-1 flex min-w-0 cursor-text items-center rounded-md border border-transparent text-left transition-[color,box-shadow,background-color,border-color] hover:bg-secondary disabled:cursor-default disabled:hover:bg-transparent',
            sizeClass,
            FOCUS_RING,
          )}
          onPointerDown={event => { pointerStart.current = { x: event.clientX, y: event.clientY }; }}
          onClick={event => {
            const start = pointerStart.current;
            pointerStart.current = null;
            if (start && event.detail > 0
              && Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_THRESHOLD) return;
            begin();
          }}
          onKeyDown={event => {
            if (event.key !== 'F2') return;
            event.preventDefault();
            event.stopPropagation();
            begin();
          }}
        >
          <span className="truncate">{value}</span>
        </button>
      )}
    </span>
  );
});
