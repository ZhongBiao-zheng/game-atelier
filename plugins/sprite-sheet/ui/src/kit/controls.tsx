/** 插件自己的基础控件。沙箱里用不了宿主的组件，这一层按 DESIGN.md 的配方重画，页面文件只组合它们。 */
import type { ReactNode } from 'react';

export function Button({ primary = false, disabled, onClick, children }: {
  primary?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode;
}) {
  return <button type="button" className={primary ? 'btn btn-primary' : 'btn'} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function NumberField({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void;
}) {
  return <label className="field">{label}
    <input className="input" type="number" inputMode="numeric" min={min} max={max} value={value}
      onChange={event => {
        const next = Math.round(Number(event.target.value));
        if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
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
