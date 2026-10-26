import { Expand, LoaderCircle, Paintbrush, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { canvasMediaUrl } from '@/api/canvas';
import { Lightbox } from '@/components/Lightbox';
import { Button } from '@/components/ui/button';
import type { CanvasImageEditNode, CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { CanvasNodeContextValue } from './CanvasEditorViews';
import { CanvasMaterialHoverDetail, type CanvasMaterialHoverState } from './CanvasMaterialHoverDetail';

type EditInput = NonNullable<Job['params']['edit_inputs']>[number];

const rawUrl = (job: Job, path: string) =>
  `/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(job.job_id)}`;

function inputLabel(role: EditInput['role'], outpaint: boolean) {
  if (role === 'source') return '原图';
  if (role === 'mask') return '蒙版';
  if (role === 'guide') return outpaint ? '扩图区' : '蒙版';
  return '参考';
}

const chip = 'inline-flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border bg-background/40 px-3 text-sm text-foreground';

/** 局部修改 / 扩图结果节点单击后的面板，沿用生成面板的框架。
 *  参考图位放产出这张图时真正发给厂商的文件（原图、蒙版、引导图，透明处棋盘格），提示词是发出去的完整内容；
 *  没有记录的旧结果放编辑节点的源图与已存蒙版。开始生成回到编辑节点重跑。 */
export function CanvasImageEditPanel({ node, edit, context, onClose }: {
  node: CanvasNode; edit: CanvasImageEditNode; context: CanvasNodeContextValue; onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [hovered, setHovered] = useState<CanvasMaterialHoverState | null>(null);
  const [zoomed, setZoomed] = useState<number | null>(null);
  const outpaint = edit.data.options.mode === 'outpaint';
  const draft = edit.data.generation_draft;
  const job = (context.jobsByResultNodeId.get(node.id) ?? []).filter(item => item.params.edit_inputs?.length).at(-1);
  const source = context.resolveVersion(edit.data.source_version_id);
  const mask = edit.data.mask_version_id ? context.resolveVersion(edit.data.mask_version_id) : undefined;
  const tiles = job
    ? (job.params.edit_inputs ?? []).map(input => ({ key: input.path, label: inputLabel(input.role, outpaint), url: rawUrl(job, input.path) }))
    : [source, mask].flatMap((version, index) => version
      ? [{ key: version.version_id, label: index ? '蒙版' : '原图', url: canvasMediaUrl(context.projectId, version.version_id) }]
      : []);
  const prompt = job?.params.edit_prompt ?? draft?.prompt ?? '';
  const alias = job?.alias ?? draft?.alias;
  const modelId = job?.model ?? draft?.model;
  const modelName = context.keys.find(key => key.alias === alias)?.models.find(model => model.id === modelId)?.name || modelId;
  const size = job ? job.params.actual_size ?? job.params.size : draft?.params.size;
  const running = Boolean(edit.data.active_run_id) || context.submittingNodeIds.has(edit.id);
  const Icon = outpaint ? Expand : Paintbrush;
  const label = outpaint ? '扩图' : '局部修改';

  async function generate() {
    if (!context.submitImageEdit || running) return;
    setSubmitting(true);
    try { await context.submitImageEdit(edit.id); } finally { setSubmitting(false); }
  }

  return (
    <section aria-label={`${label}设置`}
      className="nodrag relative overflow-hidden rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow"
      onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <Button type="button" variant="ghost" size="icon" className="absolute right-2 top-2 z-10 size-7 rounded-full"
        aria-label={`关闭${label}设置`} onClick={onClose}><X aria-hidden="true" /></Button>
      <div className="mb-1 flex min-h-12 min-w-0 items-center gap-2 overflow-x-auto px-1 py-1 pr-9">
        {tiles.map((tile, index) => {
          const showDetail = (target: HTMLElement) => {
            const bounds = target.getBoundingClientRect();
            setHovered({ reference: { nodeId: tile.key, versionId: tile.key, kind: 'image', title: tile.label, previewUrl: tile.url },
              left: bounds.left + bounds.width / 2, top: bounds.top - 8 });
          };
          return (
            <button key={tile.key} type="button" aria-label={`查看${tile.label}`}
              className="edit-checker relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onMouseEnter={event => showDetail(event.currentTarget)} onMouseLeave={() => setHovered(null)}
              onFocus={event => showDetail(event.currentTarget)} onBlur={() => setHovered(null)}
              onClick={() => { setHovered(null); setZoomed(index); }}>
              <img src={tile.url} alt={tile.label} loading="lazy" draggable={false} className="size-full object-contain" />
              <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 text-center text-xs text-foreground">{tile.label}</span>
            </button>
          );
        })}
      </div>
      {hovered && <CanvasMaterialHoverDetail {...hovered} />}
      {zoomed !== null && tiles[zoomed] && <Lightbox src={tiles[zoomed].url} onClose={() => setZoomed(null)}
        onPrevious={zoomed > 0 ? () => setZoomed(zoomed - 1) : undefined}
        onNext={zoomed < tiles.length - 1 ? () => setZoomed(zoomed + 1) : undefined} />}
      <button type="button" aria-expanded={promptExpanded} onClick={() => setPromptExpanded(value => !value)}
        className="block w-full rounded-md px-3 pb-1 pt-2 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground ${promptExpanded ? 'max-h-60 overflow-y-auto' : 'line-clamp-3'}`}>
          {prompt.trim() || <span className="text-muted-foreground">未填写提示词</span>}
        </p>
        <span className="block text-right text-xs text-muted-foreground">{promptExpanded ? '收起' : '展开'}</span>
      </button>
      <div className="mt-2 flex items-center gap-1.5 rounded-xl border border-border/70 bg-card/55 p-1.5">
        <span className={`${chip} flex-1`} title={alias ?? undefined}>
          <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{modelName ?? '未选择模型'}</span>
          {alias && <span className="ml-auto shrink-0 text-muted-foreground">{alias}</span>}
        </span>
        {size && <span className={`${chip} shrink-0 tabular-nums`}>{size.replace('x', '×')}</span>}
        <Button type="button" size="sm" className="shrink-0" disabled={running || submitting || !draft}
          onClick={() => void generate()}>
          {running || submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
          {running || submitting ? '生成中…' : '开始生成'}
        </Button>
      </div>
    </section>
  );
}
