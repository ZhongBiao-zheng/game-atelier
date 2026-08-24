import { Pencil, Trash2 } from 'lucide-react';
import { modelModality } from '@/api/keys';
import { providerLabel } from '@/lib/providerLabels';

export interface KeyRow {
  alias: string;
  provider: string;
  base_url?: string | null;
  masked_secret: string;
  capabilities?: string[];
  models?: { name: string; id: string; modality?: 'text' | 'image' | 'video' | 'audio' | null }[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: string[];
  notes?: string;
  last_used_at?: string | null;
  created_at?: string | null;
}

interface Props {
  row: KeyRow;
  onEdit: () => void;
  onDelete: () => void;
}

/** 档案柜的一行：厂商名 + 掩码/链接第二行，右侧模型摘要 chip 与 ghost 操作。 */
export function KeyCard({ row, onEdit, onDelete }: Props) {
  const linkUrl = row.homepage_url || row.base_url;
  const vendorName = providerLabel(row.provider, row.alias);
  const models = row.models ?? [];
  const textCount = models.filter((m) => modelModality(m, row) === 'text').length;
  const imageCount = models.filter((m) => modelModality(m, row) === 'image').length;
  const videoCount = models.filter((m) => modelModality(m, row) === 'video').length;
  const audioCount = models.filter((m) => modelModality(m, row) === 'audio').length;

  return (
    <div className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-secondary/30">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{vendorName}</span>
          {vendorName !== row.alias && (
            <span className="shrink-0 truncate rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
              {row.alias}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{row.masked_secret}</span>
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
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {textCount > 0 && (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            文本 {textCount}
          </span>
        )}
        {imageCount > 0 && (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            图 {imageCount}
          </span>
        )}
        {videoCount > 0 && (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            视频 {videoCount}
          </span>
        )}
        {audioCount > 0 && (
          <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            音频 {audioCount}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={`编辑 ${row.alias}`}
        >
          <Pencil size={14} aria-hidden />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`删除 ${row.alias}`}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}
