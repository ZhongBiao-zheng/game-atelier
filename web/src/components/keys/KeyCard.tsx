import { Star } from 'lucide-react';

export interface KeyRow {
  alias: string;
  provider: string;
  masked_secret: string;
  models?: { name: string; id: string }[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: string[];
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
      {row.modalities && row.modalities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {row.modalities.map((modality) => (
            <span
              key={modality}
              className="rounded-full border border-border bg-background/40 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {modality}
            </span>
          ))}
        </div>
      )}
      {(row.homepage_url || row.docs_url || row.api_key_url) && (
        <div className="flex flex-wrap gap-3 text-xs">
          {row.homepage_url && (
            <a className="text-muted-foreground hover:text-primary" href={row.homepage_url} target="_blank" rel="noreferrer">官网</a>
          )}
          {row.docs_url && (
            <a className="text-muted-foreground hover:text-primary" href={row.docs_url} target="_blank" rel="noreferrer">文档</a>
          )}
          {row.api_key_url && (
            <a className="text-muted-foreground hover:text-primary" href={row.api_key_url} target="_blank" rel="noreferrer">获取 Key</a>
          )}
        </div>
      )}
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
