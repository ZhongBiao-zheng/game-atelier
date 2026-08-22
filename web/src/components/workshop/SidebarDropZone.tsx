import { cn } from '@/lib/utils';

export function SidebarDropZone({
  label,
  active,
  onDrop,
  onDragOver,
  onDragLeave,
  children,
}: {
  label: string | null;
  active: boolean;
  onDrop: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={cn(
        'rounded-md transition-colors',
        active && 'bg-primary/5 ring-2 ring-primary/30 ring-inset',
      )}
    >
      {label && (
        <header className="px-1.5 py-1.5 text-xs font-medium uppercase tracking-label text-muted-foreground/70 select-none">
          {label}
        </header>
      )}
      {children}
    </section>
  );
}
