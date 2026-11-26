import { Button } from '@/components/ui/button';
import { DownloadIcon } from '@/components/ui/icons';

export function DiagnosticsExport({ compact = false }: { compact?: boolean }) {
  return <Button asChild variant={compact ? 'link' : 'outline'} size="sm"
    className={compact ? 'h-auto px-0 text-xs' : undefined}>
    <a href="/api/diagnostics/export" download><DownloadIcon size="sm" aria-hidden />导出诊断日志</a>
  </Button>;
}
