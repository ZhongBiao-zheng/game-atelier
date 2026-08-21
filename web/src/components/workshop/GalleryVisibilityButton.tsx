import { Eye, EyeOff, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function GalleryVisibilityButton({
  filename,
  hidden,
  loading,
  updating,
  onToggle,
}: {
  filename: string;
  hidden: boolean;
  loading: boolean;
  updating: boolean;
  onToggle: () => void;
}) {
  const label = hidden ? '恢复展示' : '从项目画廊隐藏';

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={loading || updating}
      aria-label={`${label} ${filename}`}
      aria-pressed={hidden}
      onClick={onToggle}
      className={cn(
        'min-h-11 shrink-0 px-3',
        hidden && 'bg-secondary text-foreground',
      )}
    >
      {updating ? (
        <LoaderCircle className="animate-spin" aria-hidden />
      ) : hidden ? (
        <Eye aria-hidden />
      ) : (
        <EyeOff aria-hidden />
      )}
      {updating ? '更新中…' : label}
    </Button>
  );
}
