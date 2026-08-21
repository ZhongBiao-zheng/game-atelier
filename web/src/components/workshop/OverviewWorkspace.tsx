import { Pencil, Save, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function OverviewWorkspace({
  draft,
  editing,
  dirty,
  saving,
  error,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
}: {
  draft: string;
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <section aria-labelledby="project-worldview-heading" className="space-y-4" data-testid="project-overview">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-label text-muted-foreground">项目档案</p>
          <h2 id="project-worldview-heading" className="text-base font-medium text-foreground">
            项目经验 / 世界观
          </h2>
        </div>
        {!editing && (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="size-4" aria-hidden />
            编辑
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-3">
          <Textarea
            id="worldview"
            aria-label="项目经验 / 世界观"
            value={draft}
            onChange={event => onDraftChange(event.target.value)}
            className="min-h-[360px] resize-y bg-card/50 font-mono text-sm leading-relaxed"
            spellCheck={false}
          />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
              <X className="size-4" aria-hidden />
              取消
            </Button>
            <Button type="button" onClick={onSave} disabled={saving || !dirty}>
              <Save className="size-4" aria-hidden />
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      ) : draft.trim() ? (
        <article className="rounded-lg border border-border bg-card/25 px-5 py-5 text-sm leading-relaxed text-foreground/90 md:px-7 md:py-6">
          <ReactMarkdown
            components={{
              h1: ({ node: _node, ...props }) => <h3 className="mb-4 text-base font-medium text-foreground" {...props} />,
              h2: ({ node: _node, ...props }) => <h3 className="mb-3 mt-6 text-base font-medium text-foreground first:mt-0" {...props} />,
              h3: ({ node: _node, ...props }) => <h4 className="mb-2 mt-5 text-sm font-medium text-foreground first:mt-0" {...props} />,
              p: ({ node: _node, ...props }) => <p className="my-3 first:mt-0 last:mb-0" {...props} />,
              ul: ({ node: _node, ...props }) => <ul className="my-3 list-disc space-y-1 pl-5" {...props} />,
              ol: ({ node: _node, ...props }) => <ol className="my-3 list-decimal space-y-1 pl-5" {...props} />,
              blockquote: ({ node: _node, ...props }) => <blockquote className="my-4 border-l-2 border-border pl-4 text-muted-foreground" {...props} />,
              code: ({ node: _node, ...props }) => <code className="rounded-sm bg-secondary px-1 py-0.5 font-mono text-xs" {...props} />,
            }}
          >
            {draft}
          </ReactMarkdown>
        </article>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card/20 px-5 py-8 text-sm text-muted-foreground">
          还没有项目经验或世界观说明。点“编辑”开始记录。
        </div>
      )}
    </section>
  );
}
