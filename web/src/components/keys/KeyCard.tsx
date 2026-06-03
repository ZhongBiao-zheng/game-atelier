import { Pencil, Star, Trash2 } from 'lucide-react';
import { providerLabel } from '@/lib/providerLabels';

export interface KeyRow {
  alias: string;
  provider: string;
  base_url?: string | null;
  masked_secret: string;
  capabilities?: string[];
  models?: { name: string; id: string }[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: string[];
  routing_scope?: 'general' | 'classified';
  routing_category?: string | null;
  routing_hints?: string[];
  notes?: string;
  is_default: boolean;
  last_used_at?: string | null;
  created_at?: string | null;
}

interface Props {
  row: KeyRow;
  onSetDefault: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function KeyCard({ row, onSetDefault, onEdit, onDelete }: Props) {
  const linkUrl = row.homepage_url || row.base_url;
  const vendorName = providerLabel(row.provider, row.alias);

  return (
    <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {row.is_default && (
              <Star size={14} className="fill-primary stroke-primary" aria-label="默认 Key" />
            )}
            <span className="truncate text-sm font-medium text-foreground">{vendorName}</span>
            {vendorName !== row.alias && (
              <span className="shrink-0 truncate rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {row.alias}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {linkUrl && (
              <a
                className="max-w-full truncate hover:text-primary"
                href={linkUrl}
                target="_blank"
                rel="noreferrer"
              >
                {linkUrl}
              </a>
            )}
            <span className="font-mono">{row.masked_secret}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!row.is_default && (
            <button
              type="button"
              onClick={onSetDefault}
              className="rounded-md border border-border bg-background/30 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              设为默认
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background/30 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`编辑 ${row.alias}`}
          >
            <Pencil size={14} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除 ${row.alias}`}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background/30 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
