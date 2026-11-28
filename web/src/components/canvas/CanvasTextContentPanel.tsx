import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';

import { CanvasModelPicker, type CanvasModelChoice } from '@/components/canvas/CanvasGenerationControls';
import { canvasNodeRunState } from '@/components/canvas/CanvasNodeRunStatus';
import type { CanvasNodeContextValue } from '@/components/canvas/CanvasEditorViews';
import { selectedCharacterCount } from '@/components/canvas/canvasTextRevision';
import { Button } from '@/components/ui/button';
import { AiIcon, CloseIcon, LoadingIcon, StopIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { Textarea } from '@/components/ui/textarea';
import { MOTION_DURATION, MOTION_EASE, shakeOnError } from '@/lib/motion';
import { routeChannel, storedAlias } from '@/lib/modelRoutes';
import { cn } from '@/lib/utils';
import { canvasGenerationModelSupportsMode, normalizeCanvasTextParams } from '@/pages/canvasEditorModel';
import type { CanvasGenerationDraft, CanvasNode } from '@/schema/canvas';

type TextNode = Extract<CanvasNode, { type: 'text' }>;
type TextRange = { start: number; end: number };

// 正文与选区高亮层共用同一套排版，逐字对齐。
const DOCUMENT_TYPE = 'stable-scroll whitespace-pre-wrap break-words px-2 py-1 text-sm leading-relaxed';

/** 文本节点面板的「内容」页：读全文、直接改字、让模型改选中的一段或全文。 */
export function CanvasTextContentPanel({
  node, draft, context, header, embedded = false, onClose, focusRequest = 0, instruction, onInstructionChange,
}: {
  node: TextNode;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
  header: ReactNode;
  embedded?: boolean;
  onClose?: () => void;
  /** 每次变化（双击节点、工具条「编辑」）把光标放进正文末尾。 */
  focusRequest?: number;
  /** 改写要求由外层保管，切页不丢。 */
  instruction: string;
  onInstructionChange: (value: string) => void;
}) {
  const content = context.resolveVersion(node.data.current_version_id);
  const text = content?.kind === 'text' ? content.text : '';
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const instructionRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  // 拼音组合中只改本地草稿：文档值绕一圈回来慢一拍，直接受控会打断输入法。
  const [localText, setLocalText] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState<TextRange | null>(null);
  const value = localText ?? text;
  const runState = canvasNodeRunState(node, context.jobsByRunId, context.jobsByResultNodeId);
  const running = runState.status === 'loading';
  const submitting = context.submittingNodeIds.has(node.id);
  const activeJob = runState.job;
  const setTextEditing = context.setTextEditing;

  const providers = context.generationProviders ?? context.keys;
  const choices = useMemo<CanvasModelChoice[]>(() => providers.flatMap(key => key.models
    .filter(model => canvasGenerationModelSupportsMode(key, model, 'text'))
    .map(model => ({ key, model }))), [providers]);
  const selectedChoice = choices.find(choice => choice.model.id === draft.model
    && (draft.alias == null || choice.key.alias === draft.alias));

  // 正文换了（改写结果落地、撤销）旧选区下标就不再对应原来那段字。
  useEffect(() => { setSelection(null); }, [text]);
  // 高亮层在正文失焦那一帧才挂上，先对齐正文已经滚到的位置，不然高亮落在开头。
  useLayoutEffect(() => {
    if (mirrorRef.current && editorRef.current) mirrorRef.current.scrollTop = editorRef.current.scrollTop;
  }, [selection, focused]);
  useEffect(() => {
    if (!focusRequest) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }, [focusRequest]);
  useEffect(() => () => setTextEditing?.(node.id, false), [node.id, setTextEditing]);

  function rememberSelection(editor: HTMLTextAreaElement) {
    const { selectionStart: start, selectionEnd: end } = editor;
    setSelection(end > start && editor.value.slice(start, end).trim() ? { start, end } : null);
  }

  function selectModel({ key: chosenKey, model: chosenModel }: CanvasModelChoice) {
    const { model } = routeChannel(chosenKey, chosenModel);
    context.recordHistory();
    context.updateNode(node.id, current => {
      if (current.type !== 'text') return current;
      const base = current.data.generation_draft ?? draft;
      return {
        ...current,
        data: {
          ...current.data,
          generation_draft: {
            ...base,
            alias: storedAlias(chosenKey),
            model: chosenModel.id,
            params: normalizeCanvasTextParams(model.protocol, base.params),
            updated_at: new Date().toISOString(),
          },
        },
      };
    });
  }

  function submitRevision() {
    const trimmed = instruction.trim();
    if (!trimmed) {
      instructionRef.current?.focus();
      shakeOnError(instructionRef.current);
      return;
    }
    if (!selectedChoice) {
      context.reportError?.('请先选择对话模型');
      shakeOnError(submitRef.current);
      return;
    }
    // 结果要原位写回：先把正文的编辑状态放掉，否则合并结果时会被当成本地未存改动挡住。
    editorRef.current?.blur();
    setTextEditing?.(node.id, false);
    context.recordHistory();
    void context.submitTextRevision?.(node.id, {
      instruction: trimmed,
      selection,
      alias: draft.alias ?? null,
      model: draft.model,
    });
  }

  const busy = running || submitting;
  const selectedCount = selectedCharacterCount(value, selection);
  return (
    <section
      aria-label="文本内容"
      data-floating-node-panel="true"
      className={cn(
        'nodrag relative',
        embedded ? 'canvas-mobile-generation nowheel' : 'overflow-hidden rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow',
      )}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      {onClose && (
        <Button type="button" variant="ghost" size="icon" className="absolute right-2 top-2 z-10 size-7 rounded-full"
          aria-label="关闭文本设置" onClick={onClose}>
          <CloseIcon aria-hidden="true" />
        </Button>
      )}
      <div className="mb-2 flex items-center pr-8">{header}</div>
      <div className="relative">
        {/* 焦点离开正文（去写指令）后原生选区不再显示，用一层同排版的高亮把选中的那段标出来。 */}
        {selection && !focused && (
          <div ref={mirrorRef} aria-hidden="true"
            className={cn(DOCUMENT_TYPE, 'pointer-events-none absolute inset-0 overflow-hidden text-transparent')}>
            {value.slice(0, selection.start)}
            <mark className="rounded-sm bg-primary/25 text-transparent">{value.slice(selection.start, selection.end)}</mark>
            {value.slice(selection.end)}
          </div>
        )}
        <Textarea variant="bare"
          ref={editorRef}
          aria-label={`编辑 ${node.title} 正文`}
          value={value}
          disabled={busy}
          placeholder="输入文本…"
          className={cn(
            DOCUMENT_TYPE,
            'relative block field-sizing-content min-h-40 max-h-[40vh] w-full resize-none overflow-y-auto rounded-md border-0 bg-transparent text-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60',
          )}
          onFocus={() => {
            setFocused(true);
            setLocalText(null);
            context.recordHistory();
            setTextEditing?.(node.id, true);
          }}
          onBlur={() => {
            setFocused(false);
            setLocalText(null);
            setTextEditing?.(node.id, false);
          }}
          onScroll={event => {
            if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onChange={event => {
            setLocalText(event.target.value);
            if (!(event.nativeEvent as InputEvent).isComposing) context.updateText(node.id, event.target.value);
          }}
          onCompositionEnd={event => context.updateText(node.id, event.currentTarget.value)}
          onSelect={event => rememberSelection(event.currentTarget)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.key !== 'Escape') return;
            event.currentTarget.blur();
          }}
        />
      </div>
      <div className="mt-2 flex flex-col gap-1.5 rounded-xl border border-border/70 bg-card/55 p-1.5">
        <div className="flex items-center gap-1.5">
          {/* 胶囊只淡入淡出：布局一次到位，不逐帧改输入框宽度。 */}
          <AnimatePresence initial={false}>{selectedCount > 0 && (
            <motion.span key="selection"
              className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sm bg-secondary py-0.5 pl-2 pr-0.5 text-xs tabular-nums text-foreground"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }}>
              选中 {selectedCount} 字
              <Button type="button" variant="ghost" size="icon" className="size-5 rounded-sm"
                aria-label="取消选区" onClick={() => setSelection(null)}>
                <CloseIcon size="sm" aria-hidden="true" />
              </Button>
            </motion.span>
          )}</AnimatePresence>
          <Input
            ref={instructionRef}
            aria-label="改写要求"
            value={instruction}
            disabled={busy}
            placeholder={selectedCount > 0 ? '这段怎么改？' : '怎么改？'}
            onChange={event => onInstructionChange(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!busy) submitRevision();
            }}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <CanvasModelPicker fit="content" choices={choices} alias={draft.alias ?? null} model={draft.model}
            params={draft.params} onSelect={selectModel} />
          <span className="flex-1" />
          {/* 任务还没回到列表（running 但没有 activeJob）时按钮留在原地转圈，不整个消失。 */}
          <Button ref={submitRef} type="button" size="sm" variant={running ? 'outline' : 'default'}
            className="shrink-0 transition-colors"
            disabled={running ? !activeJob || Boolean(activeJob.cancel_requested_at) : submitting || !value.trim()}
            onClick={running ? () => { if (activeJob) void context.cancelRun(activeJob.canvas_run!.run_id); } : submitRevision}>
            <SwapIcon swapKey={running ? 'running' : submitting ? 'submitting' : 'idle'}>
              {submitting || activeJob?.cancel_requested_at || (running && !activeJob)
                ? <LoadingIcon className="animate-spin" aria-hidden="true" />
                : running ? <StopIcon aria-hidden="true" /> : <AiIcon aria-hidden="true" />}
            </SwapIcon>
            {/* 「停止中…」与「提交中…」等宽，「停止」与「改写」等宽：两段叠格占宽，换态时按钮不跳。 */}
            <SwapLabel active={submitting || Boolean(activeJob?.cancel_requested_at) || (running && !activeJob)}
              on={activeJob?.cancel_requested_at ? '停止中…' : '提交中…'} off={running ? '停止' : '改写'} />
          </Button>
        </div>
      </div>
    </section>
  );
}
