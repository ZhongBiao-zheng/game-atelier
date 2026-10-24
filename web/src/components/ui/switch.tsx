interface SwitchProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export function Switch({ checked, label, disabled, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border border-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${checked ? 'bg-primary' : 'bg-secondary'}`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 size-[18px] rounded-full transition-[left] ${checked ? 'left-[22px] bg-primary-foreground' : 'left-0.5 bg-background'}`}
      />
    </button>
  );
}
