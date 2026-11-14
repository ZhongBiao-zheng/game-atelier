/** 插件自己的基础控件。沙箱里用不了宿主的组件，这一层按 DESIGN.md 的配方重画，页面文件只组合它们。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Button({ primary = false, small = false, disabled, onClick, children }: {
  primary?: boolean; small?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode;
}) {
  const className = ['btn', primary ? 'btn-primary' : '', small ? 'btn-sm' : ''].filter(Boolean).join(' ');
  return <button type="button" className={className} disabled={disabled} onClick={onClick}>{children}</button>;
}

/** 全角数字与负号换成半角：中文输入法下直接打出的数字也能用。 */
export function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/[－ー—]/g, '-').trim();
}

/**
 * 数值输入。用文本框而不是 number：number 框在输入法组合期间拿不到中间文字，值会变成空。
 * 组合期间与解析不出数字时只改显示，不往外写；组合结束、失焦时才提交或恢复。
 */
export function NumberField({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const composing = useRef(false);
  useEffect(() => { if (!editing) setText(String(value)); }, [value, editing]);
  const commit = (raw: string) => {
    const parsed = Number(normalizeDigits(raw));
    if (normalizeDigits(raw) === '' || !Number.isFinite(parsed)) return;
    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    if (next !== value) onChange(next);
  };
  return <label className="field">{label}
    <input className="input" type="text" inputMode="numeric" autoComplete="off" value={text}
      onFocus={() => setEditing(true)}
      onBlur={() => { setEditing(false); setText(String(value)); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; commit(event.currentTarget.value); }}
      onChange={event => {
        setText(event.target.value);
        if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) commit(event.target.value);
      }} />
  </label>;
}

export function SelectField<Value extends string>({ label, value, options, onChange }: {
  label: string; value: Value; options: ReadonlyArray<{ value: Value; label: string }>; onChange: (value: Value) => void;
}) {
  return <label className="field">{label}
    <select className="input" value={value} onChange={event => onChange(event.target.value as Value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="check">
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}
  </label>;
}
