export function Home() {
  return (
    <div className="px-6 py-12 text-foreground">
      <h1
        className="text-5xl italic mb-3"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        Atelier
      </h1>
      <p className="text-sm text-muted-foreground italic">一间安静的暖色画廊</p>
      <p className="mt-8 text-sm text-muted-foreground">(masonry 占位 — T6 实现)</p>
    </div>
  );
}
