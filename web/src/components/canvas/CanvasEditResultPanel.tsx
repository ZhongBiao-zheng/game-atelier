import { Expand, LoaderCircle, Paintbrush, Settings2, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import type { CanvasImageEditNode, CanvasMediaVersion } from '@/schema/canvas';
import { CanvasImageEditSurface } from './CanvasImageEditSurface';
import type { CanvasNodeContextValue } from './CanvasEditorViews';

/** 局部修改 / 扩图结果节点的面板：只读展示这次编辑用到的原图、选区或画框、提示词与模型。
 *  再次生成与修改设置都回到编辑节点，结果节点自身不带生成配置。 */
export function CanvasEditResultPanel({ edit, context, onClose }: {
  edit: CanvasImageEditNode; context: CanvasNodeContextValue; onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const outpaint = edit.data.options.mode === 'outpaint';
  const source = context.resolveVersion(edit.data.source_version_id) as CanvasMediaVersion | undefined;
  const draft = edit.data.generation_draft;
  const key = context.keys.find(item => item.alias === draft?.alias);
  const modelName = key?.models.find(model => model.id === draft?.model)?.name || draft?.model;
  const running = Boolean(edit.data.active_run_id) || context.submittingNodeIds.has(edit.id);
  const Icon = outpaint ? Expand : Paintbrush;
  const label = outpaint ? '扩图' : '局部修改';
  const thumb = 'relative grid h-24 w-full place-items-center overflow-hidden rounded-lg border border-border bg-secondary/40';

  async function regenerate() {
    if (!context.submitImageEdit || running) return;
    setSubmitting(true);
    try { await context.submitImageEdit(edit.id); } finally { setSubmitting(false); }
  }

  return (
    <section aria-label={`${label}过程`}
      className="nodrag relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow"
      onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <Button type="button" variant="ghost" size="icon" className="absolute right-2 top-2 size-7 rounded-full"
        aria-label={`关闭${label}过程`} onClick={onClose}><X aria-hidden="true" /></Button>
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-4 text-primary" aria-hidden="true" />{label}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <figure className="flex flex-col gap-1">
          <button type="button" className={thumb} aria-label="查看原图" disabled={!source}
            onClick={() => source && context.previewContent(source.version_id, '原图', edit.id)}>
            {source && <img src={canvasMediaUrl(context.projectId, source.version_id, 320)} alt="原图"
              className="absolute inset-0 size-full object-contain" draggable={false} />}
          </button>
          <figcaption className="text-xs text-muted-foreground">原图</figcaption>
        </figure>
        <figure className="flex flex-col gap-1">
          <button type="button" className={thumb} aria-label={outpaint ? '查看画框' : '查看选区'}
            onClick={() => context.openImageEdit?.(edit.id)}>
            <CanvasImageEditSurface node={edit} source={source} projectId={context.projectId} />
          </button>
          <figcaption className="text-xs text-muted-foreground">{outpaint ? '画框' : '选区'}</figcaption>
        </figure>
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap text-sm text-foreground">
        {draft?.prompt.trim() || <span className="text-muted-foreground">未填写提示词</span>}
      </p>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={draft?.alias ?? undefined}>
          {modelName ? `${modelName}${draft?.alias ? ` · ${draft.alias}` : ''}` : '未选择模型'}
        </span>
        <Button type="button" variant="outline" size="sm" className="shrink-0"
          onClick={() => context.openImageEdit?.(edit.id)}><Settings2 aria-hidden="true" />修改设置</Button>
        <Button type="button" size="sm" className="shrink-0" disabled={running || submitting || !draft}
          onClick={() => void regenerate()}>
          {running || submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
          {running || submitting ? '生成中…' : '再次生成'}
        </Button>
      </div>
    </section>
  );
}
