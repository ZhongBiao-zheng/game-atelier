import { WaitingCopy } from './WaitingCopy';

export type RoundState =
  | { kind: 'pending'; startedAt: number; promptPreview: string }
  | { kind: 'done'; submittedAt: string; imagePath: string }
  | { kind: 'failed'; submittedAt: string; reason: string };

export function RoundList({ rounds }: { rounds: RoundState[] }) {
  if (rounds.length === 0) return null;
  return (
    <div className="max-w-3xl mx-auto mt-8 space-y-8">
      {rounds.map((r) => {
        const stableKey =
          r.kind === 'pending' ? `pending-${r.startedAt}` : `${r.kind}-${r.submittedAt}`;
        return (
          <div key={stableKey}>
            <div className="border-t border-border/40 pt-3 mb-3 flex items-baseline gap-3">
              <span className="text-xs text-muted-foreground font-mono">
                {r.kind === 'pending'
                  ? new Date(r.startedAt).toLocaleTimeString()
                  : new Date(r.submittedAt).toLocaleTimeString()}
              </span>
              {r.kind === 'pending' && <WaitingCopy startedAt={r.startedAt} />}
            </div>
            {r.kind === 'pending' && (
              <div
                data-skeleton
                aria-busy="true"
                className="aspect-square w-64 bg-card/40 rounded-lg flex items-center justify-center"
              >
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {r.kind === 'done' && (
              <img
                src={`/api/gallery/image?path=${encodeURIComponent(r.imagePath)}`}
                alt=""
                className="rounded-lg border border-border/40 max-w-sm"
              />
            )}
            {r.kind === 'failed' && (
              <div className="border border-destructive/40 rounded-lg p-4 max-w-sm text-sm">
                <p className="text-foreground">生成失败</p>
                <p className="text-xs text-muted-foreground mt-1">{r.reason}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
