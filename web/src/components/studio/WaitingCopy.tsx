export function WaitingCopy({ startedAt, now }: { startedAt: number; now: number }) {
  const elapsed = Math.floor((now - startedAt) / 1000);
  let copy = '';
  if (elapsed >= 30) copy = '可能要再等一会，复杂场景慢一点。';
  else if (elapsed >= 15) copy = '模型在画了…';
  else if (elapsed >= 5) copy = '正在调度…';
  return (
    <div className="text-xs text-muted-foreground font-mono">
      {elapsed}s
      {copy && <span className="ml-2">{copy}</span>}
    </div>
  );
}
