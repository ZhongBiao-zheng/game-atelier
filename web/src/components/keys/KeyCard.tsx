import { Star } from 'lucide-react';

export interface KeyRow {
  alias: string;
  provider: string;
  masked_secret: string;
  models?: { name: string; id: string }[];
  is_default: boolean;
  last_used_at?: string | null;
  created_at?: string | null;
}

interface Props {
  row: KeyRow;
  onSetDefault: () => void;
  onDelete: () => void;
}

export function KeyCard({ row, onSetDefault, onDelete }: Props) {
  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-2 w-full max-w-2xl">
      <div className="flex items-center gap-2">
        {row.is_default && (
          <Star size={14} className="fill-primary stroke-primary" aria-label="默认 Key" />
        )}
        <span className="text-sm font-medium text-foreground">{row.alias}</span>
        <span className="text-xs text-muted-foreground">{row.provider}</span>
      </div>
      <div className="font-mono text-sm text-muted-foreground">{row.masked_secret}</div>
      {row.models && row.models.length > 0 && (
        <div className="text-xs text-muted-foreground">{row.models.length} 个模型</div>
      )}
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-muted-foreground">
          {row.last_used_at ? `最近使用 ${formatRelative(row.last_used_at)}` : '从未使用'}
          {row.created_at && ` · 创建 ${formatRelative(row.created_at)}`}
        </span>
        <div className="flex gap-3">
          {!row.is_default && (
            <button
              type="button"
              onClick={onSetDefault}
              className="text-xs text-muted-foreground hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
            >
              设为默认
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除 ${row.alias}`}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive rounded"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} 天前`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} 小时前`;
  return '刚刚';
}
