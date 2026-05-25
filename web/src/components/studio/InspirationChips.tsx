const FALLBACK_CHIPS = [
  "soft cotton low-angle warm tungsten",
  "逆光逐光剑客 cinematic",
  "清晨厨房静物 painterly",
];

export function InspirationChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 mt-4 justify-center">
      {FALLBACK_CHIPS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          className="text-xs text-muted-foreground bg-card border border-border/60 rounded-full px-3 py-1.5 hover:text-foreground hover:border-primary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          试试: "{c}"
        </button>
      ))}
    </div>
  );
}
