import { Expand, Minus, Move, Plus } from 'lucide-react';
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import { selectionImageCaps } from '@/lib/modelRoutes';
import { MJ_IMAGES_PER_TASK } from '@/lib/imageControlCaps';
import { defaultResolution } from '@/lib/studioSize';
import { EditGenerationControls } from './EditGenerationControls';
import { editModelChoices, editSize, EXPAND_RATIOS, EXPAND_SCALES, presetFrame, presetScale,
  type EditFrame, type ExpandRatio } from './imageEditGeometry';
import { EditorComposer, ImageEditorShell, editorIconButton, useEditorViewport,
  type CanvasMaskEditSubmission, type ImageEditorProps } from './ImageEditorShell';

type DragKind = 'image' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: DragKind[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const choiceId = (alias: string, model: string) => `${alias}\u0000${model}`;

function RatioIcon({ ratio, width, height }: { ratio: ExpandRatio; width: number; height: number }) {
  const [a, b] = ratio === 'original' ? [width, height] : ratio.split(':').map(Number);
  const box = a >= b ? { width: 18, height: Math.max(8, Math.round(18 * b / a)) } : { width: Math.max(8, Math.round(18 * a / b)), height: 18 };
  return <i aria-hidden className={`block rounded-xs border-[1.5px] border-current ${ratio === 'original' ? 'border-dashed' : ''}`} style={box} />;
}

/** 扩图：比例 + 倍数决定画框，原图可拖动定位；默认 Midjourney，可切换其它图片编辑模型。 */
export function CanvasOutpaintEditor({ open, title, version, mediaUrl, keys, initialData, busy: parentBusy, error,
  onOpenChange, onSave, onSubmit }: ImageEditorProps) {
  const initialDraft = initialData?.generation_draft ?? null;
  const source = { width: version.width || 1, height: version.height || 1 };
  const savedFrame = initialData?.editor_state.frame;
  const savedRatio = initialData?.editor_state.frame_ratio ?? '';
  const [serializing, setSerializing] = useState(false);
  const busy = parentBusy || serializing;
  const [ready, setReady] = useState(false);
  const [ratio, setRatio] = useState<ExpandRatio | ''>((EXPAND_RATIOS as readonly string[]).includes(savedRatio) ? savedRatio as ExpandRatio : '');
  const [scaleStep, setScaleStep] = useState<number | null>(savedFrame ? presetScale(source.width, source.height, savedRatio, savedFrame) : 1);
  const [frame, setFrame] = useState<EditFrame>(savedFrame ?? presetFrame(source.width, source.height, 'original', 1));
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const choices = useMemo(() => editModelChoices(keys), [keys]);
  const [selected, setSelected] = useState(() => {
    const saved = choices.find(item => item.key.alias === initialDraft?.alias && item.model === initialDraft?.model) ?? choices[0];
    return saved ? choiceId(saved.key.alias, saved.model) : '';
  });
  const choice = choices.find(item => choiceId(item.key.alias, item.model) === selected);
  const [count, setCount] = useState(initialDraft?.params.n ?? 1);
  const caps = selectionImageCaps(choice?.key, choice?.model ?? '');
  const [qualityChoice, setQualityChoice] = useState(initialDraft?.params.quality);
  const [resolutionChoice, setResolutionChoice] = useState(initialDraft?.params.resolution);
  const quality = caps.qualities?.includes(qualityChoice as never) ? qualityChoice
    : caps.qualities?.includes('auto' as never) ? 'auto' : caps.qualities?.[0];
  const resolution = !caps.showResolution ? undefined
    : caps.resolutions.includes(resolutionChoice as never) ? resolutionChoice : defaultResolution(caps.resolutions);
  const mj = Boolean(choice?.mj);
  const candidates = mj ? MJ_IMAGES_PER_TASK : count;
  const viewport = useEditorViewport(frame);
  const { scale, origin } = viewport;
  const drag = useRef<{ kind: DragKind; x: number; y: number; frame: EditFrame } | null>(null);
  const size = editSize(choice?.key, choice?.model ?? '', frame.width, frame.height);
  const contains = frame.x >= 0 && frame.y >= 0 && frame.x + source.width <= frame.width && frame.y + source.height <= frame.height;
  const expanded = frame.width > source.width || frame.height > source.height;
  const fingerprint = JSON.stringify({ frame, ratio, prompt, selected, count, quality, resolution });
  const savedFingerprint = useRef(fingerprint);
  const cost = estimateGenerationCostForSubmission(choice?.key, choice?.model ?? '', 'image',
    { ...size.params, n: candidates, quality, resolution, ...(mj ? { image_edit: { mode: 'outpaint' } } : {}) });
  const blocker = !choice ? '需要可用的图片编辑模型' : !ready ? '图片加载中' : initialData?.active_run_id ? '正在生成'
    : !contains || !expanded ? '画框需要比原图大' : size.error ? size.error : mj && !prompt.trim() ? '写下扩出来的画面' : null;

  function applyPreset(nextRatio: ExpandRatio, nextScale: number) {
    setRatio(nextRatio); setScaleStep(nextScale);
    setFrame(presetFrame(source.width, source.height, nextRatio, nextScale));
  }
  function stepScale(direction: 1 | -1) {
    if (!ratio || scaleStep == null) return;
    const index = EXPAND_SCALES.indexOf(scaleStep as typeof EXPAND_SCALES[number]);
    applyPreset(ratio, EXPAND_SCALES[Math.min(EXPAND_SCALES.length - 1, Math.max(0, index + direction))]);
  }
  function startDrag(event: ReactPointerEvent, kind: DragKind) {
    if (busy || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { kind, x: event.clientX, y: event.clientY, frame };
  }
  function moveDrag(event: ReactPointerEvent) {
    if (viewport.movePan(event)) return;
    const current = drag.current;
    if (!current) return;
    const dx = (event.clientX - current.x) / scale;
    const dy = (event.clientY - current.y) / scale;
    const next = { ...current.frame };
    if (current.kind === 'image') {
      next.x = Math.round(Math.max(0, Math.min(next.width - source.width, next.x + dx)));
      next.y = Math.round(Math.max(0, Math.min(next.height - source.height, next.y + dy)));
    } else {
      if (current.kind.includes('e')) next.width = Math.round(Math.max(next.x + source.width, next.width + dx));
      if (current.kind.includes('s')) next.height = Math.round(Math.max(next.y + source.height, next.height + dy));
      if (current.kind.includes('w')) { const delta = Math.round(Math.max(-next.x, -dx)); next.width += delta; next.x += delta; }
      if (current.kind.includes('n')) { const delta = Math.round(Math.max(-next.y, -dy)); next.height += delta; next.y += delta; }
      setRatio(''); setScaleStep(null);
    }
    setFrame(next);
  }
  function endDrag() { drag.current = null; viewport.endPan(); }

  async function submit(generate: boolean): Promise<boolean> {
    if (busy || (generate && blocker)) return false;
    setSerializing(true); setLocalError(null);
    try {
      const submission: CanvasMaskEditSubmission = {
        mask: null, requestedCount: candidates, options: { mode: 'outpaint', ...frame },
        editorState: { strokes: [], frame, frame_ratio: ratio },
        referenceNodeId: null, referenceVersionId: null,
        draft: { mode: 'image', prompt: prompt.trim(), input_policy: 'all_connected', alias: choice?.key.alias ?? '',
          model: choice?.model ?? '', updated_at: new Date().toISOString(),
          params: mj ? { n: MJ_IMAGES_PER_TASK } : { ...size.params, n: count, ...(quality ? { quality } : {}), ...(resolution ? { resolution } : {}) } },
      };
      const ok = await (generate ? onSubmit(submission) : onSave(submission));
      if (ok) savedFingerprint.current = fingerprint;
      return ok;
    } catch (error) {
      setLocalError((error as Error).message);
      return false;
    } finally { setSerializing(false); }
  }

  const handleStyle = (direction: DragKind) => ({
    left: direction.includes('w') ? 0 : direction.includes('e') ? '100%' : '50%',
    top: direction.includes('n') ? 0 : direction.includes('s') ? '100%' : '50%',
    cursor: `${direction}-resize`,
  });

  return <ImageEditorShell open={open} heading="扩图" icon={Expand}
    viewport={viewport} busy={busy} dirty={fingerprint !== savedFingerprint.current} onClose={() => onOpenChange(false)}
    onAutoSave={() => submit(false)}
    stageBottom="bottom-56"
    stage={<div className="relative size-full"
      onPointerDown={event => { if (event.target === event.currentTarget) viewport.startPan(event); }}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <div aria-label="扩图画框" className="edit-dot-grid-dense absolute bg-card outline outline-1 outline-foreground/35"
        style={{ left: origin.x, top: origin.y, width: frame.width * scale, height: frame.height * scale }}>
        <div className="group absolute cursor-move outline outline-1 outline-foreground/50" onPointerDown={event => startDrag(event, 'image')}
          style={{ left: frame.x * scale, top: frame.y * scale, width: source.width * scale, height: source.height * scale }}>
          <img src={mediaUrl} alt={title} draggable={false} className="block size-full select-none"
            onLoad={() => setReady(true)} onError={() => { setReady(false); setLocalError('源图片加载失败'); }} />
          <span aria-hidden className="absolute left-1/2 top-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-background/70 text-foreground opacity-80 group-hover:opacity-100">
            <Move className="size-4" />
          </span>
        </div>
        {HANDLES.map(direction => {
          const corner = direction.length === 2;
          const vertical = direction === 'e' || direction === 'w';
          return <button key={direction} type="button" aria-label={`扩展画框 ${direction}`} onPointerDown={event => startDrag(event, direction)}
            className="absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={handleStyle(direction)}>
            {corner
              ? <span aria-hidden className="size-4 border-foreground" style={{
                borderTopWidth: direction.includes('n') ? 3 : 0, borderBottomWidth: direction.includes('s') ? 3 : 0,
                borderLeftWidth: direction.includes('w') ? 3 : 0, borderRightWidth: direction.includes('e') ? 3 : 0,
                transform: `translate(${direction.includes('w') ? 5 : -5}px, ${direction.includes('n') ? 5 : -5}px)` }} />
              : <span aria-hidden className={`rounded-sm bg-foreground ${vertical ? 'h-8 w-1' : 'h-1 w-8'}`} />}
          </button>;
        })}
        <span aria-label="编辑输出尺寸" className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-background/85 px-2.5 py-0.5 font-mono text-xs">
          {frame.width} × {frame.height}
        </span>
      </div>
    </div>}
    composer={<EditorComposer prompt={prompt} onPrompt={setPrompt}
      placeholder={mj ? '描述扩出来的画面（必填）' : '留空自然延展；或描述新增画面'}
      blocker={blocker} error={error || localError} cost={cost} busy={busy}
      generateLabel={`生成 ${candidates} 张`} onGenerate={() => void submit(true)}
      chips={<EditGenerationControls choices={choices} choice={choice}
        onChoice={next => setSelected(choiceId(next.key.alias, next.model))} caps={caps}
        resolution={resolution} onResolution={setResolutionChoice} quality={quality} onQuality={setQualityChoice}
        count={count} onCount={setCount} />}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="画框比例" className="flex flex-wrap items-center gap-0.5">
          {EXPAND_RATIOS.map(item => <button key={item} type="button" role="radio" aria-checked={ratio === item}
            onClick={() => applyPreset(item, item === 'original' ? 1 : scaleStep ?? 1)}
            className={`inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${ratio === item ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            <RatioIcon ratio={item} width={source.width} height={source.height} />{item === 'original' ? '原比例' : item}
          </button>)}
        </div>
        <div className="ml-auto flex h-8 items-center gap-0.5 rounded-full border border-border px-0.5">
          <span className="sr-only">扩展倍数</span>
          <button type="button" aria-label="减小扩展倍数" className={`${editorIconButton} size-7`} disabled={!ratio || scaleStep === EXPAND_SCALES[0]} onClick={() => stepScale(-1)}><Minus /></button>
          <span className="w-12 text-center font-mono text-xs">{scaleStep == null ? '自定义' : `${scaleStep}×`}</span>
          <button type="button" aria-label="增大扩展倍数" className={`${editorIconButton} size-7`} disabled={!ratio || scaleStep === EXPAND_SCALES.at(-1)} onClick={() => stepScale(1)}><Plus /></button>
        </div>
      </div>
    </EditorComposer>} />;
}
