import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { FileAudio, FileImage, FileText, FileVideo } from 'lucide-react';

import {
  canvasMentionMatches,
  canvasMentionToken,
  mentionKindLabel,
  type CanvasMentionReference,
} from '@/lib/canvasMentions';
import { cn } from '@/lib/utils';

interface MentionState {
  query: string;
  rect: DOMRect | null;
  start: number;
  end: number;
}

interface CanvasPromptInputProps {
  value: string;
  references: readonly CanvasMentionReference[];
  onChange: (value: string) => void;
  onFocus?: () => void;
  onPreviewReference?: (reference: CanvasMentionReference) => void;
  placeholder?: string;
  className?: string;
}

export function CanvasPromptInput({
  value,
  references,
  onChange,
  onFocus,
  onPreviewReference,
  placeholder,
  className,
}: CanvasPromptInputProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const composingRef = useRef(false);
  const lastEmittedRef = useRef(value);
  const lastReferenceSignatureRef = useRef('');
  const previewRef = useRef(onPreviewReference);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const referenceById = useMemo(
    () => new Map(references.map(reference => [reference.nodeId, reference])),
    [references],
  );
  const referenceSignature = references
    .map(reference => `${reference.nodeId}:${reference.versionId}:${reference.label}:${reference.title}`)
    .join('|');
  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLocaleLowerCase();
    if (!query) return [...references];
    return references.filter(reference => (
      `${reference.label} ${reference.title} ${mentionKindLabel(reference.kind)} ${reference.text ?? ''}`
        .toLocaleLowerCase()
        .includes(query)
    ));
  }, [mention, references]);

  useEffect(() => {
    previewRef.current = onPreviewReference;
  }, [onPreviewReference]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (
      document.activeElement === editor
      && value === lastEmittedRef.current
      && referenceSignature === lastReferenceSignatureRef.current
    ) return;
    editor.replaceChildren(...promptNodes(value, referenceById));
    lastEmittedRef.current = value;
    lastReferenceSignatureRef.current = referenceSignature;
  }, [referenceById, referenceSignature, value]);

  function closeMention() {
    setMention(null);
    setActiveIndex(0);
  }

  function syncMention() {
    const editor = editorRef.current;
    if (!editor || !references.length) {
      closeMention();
      return;
    }
    const before = textBeforeCaret(editor);
    const match = /@([^\s@]*)$/.exec(before);
    if (!match) {
      closeMention();
      return;
    }
    const serializedBefore = serializedPromptBeforeCaret(editor);
    setMention({
      query: match[1] ?? '',
      rect: caretRect(editor),
      start: Math.max(0, serializedBefore.length - match[0].length),
      end: serializedBefore.length,
    });
    setActiveIndex(0);
  }

  function emit(next: string) {
    lastEmittedRef.current = next;
    onChange(next);
  }

  function syncFromEditor() {
    const editor = editorRef.current;
    if (!editor) return;
    emit(serializePromptEditor(editor));
    syncMention();
  }

  function insertReference(reference: CanvasMentionReference) {
    const editor = editorRef.current;
    if (!editor || !mention) return;
    const current = serializePromptEditor(editor);
    const token = `${canvasMentionToken(reference.nodeId)} `;
    const next = `${current.slice(0, mention.start)}${token}${current.slice(mention.end)}`;
    const caretOffset = mention.start + token.length;
    const marked = `${next.slice(0, caretOffset)}\uFEFF${next.slice(caretOffset)}`;
    editor.replaceChildren(...promptNodes(marked, referenceById));
    placeCaretAtMarker(editor);
    closeMention();
    emit(next);
  }

  return (
    <div className="relative min-w-0">
      {!value && placeholder && (
        <span className="pointer-events-none absolute left-3 top-3 text-sm leading-relaxed text-muted-foreground">
          {placeholder}
        </span>
      )}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="combobox"
        aria-label="提示词"
        aria-autocomplete="list"
        aria-expanded={Boolean(mention && candidates.length)}
        aria-controls={mention && candidates.length ? menuId : undefined}
        aria-activedescendant={mention && candidates.length
          ? `${menuId}-option-${Math.min(activeIndex, candidates.length - 1)}`
          : undefined}
        className={cn(
          'min-h-28 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-transparent px-3 py-3 text-sm leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring',
          className,
        )}
        onFocus={onFocus}
        onInput={() => {
          if (!composingRef.current) syncFromEditor();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          syncFromEditor();
        }}
        onClick={event => {
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-canvas-mention-id]')
            : null;
          const reference = target?.dataset.canvasMentionId
            ? referenceById.get(target.dataset.canvasMentionId)
            : undefined;
          if (!reference || reference.kind === 'text') return;
          event.preventDefault();
          event.stopPropagation();
          previewRef.current?.(reference);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (mention && candidates.length) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex(index => (index + 1) % candidates.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex(index => (index - 1 + candidates.length) % candidates.length);
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              closeMention();
              return;
            }
          }
          if (
            (event.key === 'Backspace' || event.key === 'Delete')
            && deleteAdjacentMention(event.key)
          ) {
            event.preventDefault();
            requestAnimationFrame(syncFromEditor);
          }
        }}
        onKeyUp={event => {
          if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
            syncMention();
          }
        }}
        onBlur={() => {
          const editor = editorRef.current;
          if (editor) editor.replaceChildren(...promptNodes(lastEmittedRef.current, referenceById));
          window.setTimeout(closeMention, 120);
        }}
      />
      {mention && candidates.length > 0 && (
        <CanvasMentionMenu
          anchor={mention.rect}
          menuId={menuId}
          references={candidates}
          activeIndex={Math.min(activeIndex, candidates.length - 1)}
          onSelect={insertReference}
        />
      )}
    </div>
  );
}

function CanvasMentionMenu({
  anchor,
  menuId,
  references,
  activeIndex,
  onSelect,
}: {
  anchor: DOMRect | null;
  menuId: string;
  references: readonly CanvasMentionReference[];
  activeIndex: number;
  onSelect: (reference: CanvasMentionReference) => void;
}) {
  const selectedRef = useRef(false);
  const activeRef = useRef<HTMLButtonElement>(null);
  const fallback = new DOMRect(16, 16, 0, 0);
  const rect = anchor ?? fallback;
  const width = 288;
  const height = Math.min(240, references.length * 52 + 8);
  const gap = 8;
  const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8));
  const above = rect.bottom + gap + height > window.innerHeight && rect.top > height + gap;
  const top = above ? rect.top - gap - height : rect.bottom + gap;

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  function select(reference: CanvasMentionReference) {
    if (selectedRef.current) return;
    selectedRef.current = true;
    onSelect(reference);
  }

  return createPortal(
    <div
      className="fixed z-20 max-h-60 w-72 overflow-y-auto rounded-xl border border-border bg-card p-1"
      style={{ left, top }}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => event.stopPropagation()}
    >
      <div
        id={menuId}
        role="listbox"
        aria-label="引用已连接内容"
        data-canvas-mention-menu="true"
        className="grid gap-y-1 rounded-lg bg-popover"
      >
        {references.map((reference, index) => (
          <button
            id={`${menuId}-option-${index}`}
            key={reference.nodeId}
            ref={index === activeIndex ? activeRef : undefined}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={index === activeIndex}
            aria-label={`${reference.label} ${reference.title}`}
            className="flex h-12 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs text-foreground transition-colors hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/60"
            onPointerDown={event => {
              event.preventDefault();
              event.stopPropagation();
              select(reference);
            }}
          >
            <MentionPreview reference={reference} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{reference.label}</span>
              <span className="block truncate text-muted-foreground">{reference.text || reference.title}</span>
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function MentionPreview({ reference }: { reference: CanvasMentionReference }) {
  if (reference.kind === 'image' && reference.previewUrl) {
    return <img src={reference.previewUrl} alt="" className="size-9 shrink-0 rounded-md object-cover" />;
  }
  if (reference.kind === 'video' && reference.previewUrl) {
    return <video src={reference.previewUrl} className="size-9 shrink-0 rounded-md bg-black object-cover" muted preload="metadata" />;
  }
  const Icon = reference.kind === 'audio'
    ? FileAudio
    : reference.kind === 'video'
      ? FileVideo
      : reference.kind === 'image'
        ? FileImage
        : FileText;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

function promptNodes(
  value: string,
  references: ReadonlyMap<string, CanvasMentionReference>,
): Node[] {
  const nodes: Node[] = [];
  let lastIndex = 0;
  for (const match of canvasMentionMatches(value)) {
    if (match.index > lastIndex) nodes.push(document.createTextNode(value.slice(lastIndex, match.index)));
    nodes.push(mentionChip(references.get(match.nodeId), match.nodeId));
    lastIndex = match.index + match.token.length;
  }
  if (lastIndex < value.length) nodes.push(document.createTextNode(value.slice(lastIndex)));
  return nodes.length ? nodes : [document.createTextNode('')];
}

function mentionChip(reference: CanvasMentionReference | undefined, nodeId?: string): HTMLElement {
  const id = reference?.nodeId ?? nodeId ?? '';
  const wrapper = document.createElement('span');
  wrapper.setAttribute('contenteditable', 'false');
  wrapper.dataset.canvasMentionId = id;
  wrapper.dataset.canvasMentionToken = canvasMentionToken(id);
  wrapper.className = 'mx-0.5 inline-flex h-7 max-w-40 items-center gap-1 overflow-hidden rounded-md border border-border bg-secondary px-1.5 align-middle text-xs leading-none text-foreground';
  if (!reference) {
    wrapper.className += ' border-destructive/70 text-destructive';
    wrapper.setAttribute('aria-label', `引用已断开：${id}`);
    wrapper.title = `引用已断开：${id}`;
    wrapper.textContent = '引用已断开';
    return wrapper;
  }
  wrapper.setAttribute('aria-label', `引用${mentionKindLabel(reference.kind)}：${reference.title}`);
  wrapper.title = `${reference.label} · ${reference.title}`;
  if (reference.kind === 'image' && reference.previewUrl) {
    const image = document.createElement('img');
    image.src = reference.previewUrl;
    image.alt = '';
    image.className = 'size-5 shrink-0 rounded object-cover';
    wrapper.append(image);
  }
  const label = document.createElement('span');
  label.className = 'truncate';
  label.textContent = reference.label;
  wrapper.append(label);
  return wrapper;
}

export function serializePromptEditor(editor: HTMLElement): string {
  return serializeNodes(editor.childNodes).replace(/\uFEFF/g, '');
}

function serializeNodes(nodes: NodeListOf<ChildNode>): string {
  let value = '';
  nodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      value += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.canvasMentionToken) {
      value += node.dataset.canvasMentionToken;
      return;
    }
    if (node.tagName === 'BR') {
      value += '\n';
      return;
    }
    const inner = serializeNodes(node.childNodes);
    value += inner;
  });
  return value;
}

function textBeforeCaret(editor: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return '';
  const range = selection.getRangeAt(0).cloneRange();
  if (!editor.contains(range.startContainer) && range.startContainer !== editor) return '';
  range.setStart(editor, 0);
  return range.toString();
}

function caretRect(editor: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return editor.getBoundingClientRect();
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  return typeof range.getBoundingClientRect === 'function'
    ? range.getBoundingClientRect()
    : editor.getBoundingClientRect();
}

function serializedPromptBeforeCaret(editor: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return '';
  const range = selection.getRangeAt(0).cloneRange();
  if (!editor.contains(range.startContainer) && range.startContainer !== editor) return '';
  range.setStart(editor, 0);
  const fragment = range.cloneContents();
  const container = document.createElement('div');
  container.append(fragment);
  return serializePromptEditor(container);
}

function placeCaretAtMarker(editor: HTMLElement) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.textContent ?? '';
    const markerIndex = value.indexOf('\uFEFF');
    if (markerIndex >= 0) {
      node.textContent = `${value.slice(0, markerIndex)}${value.slice(markerIndex + 1)}`;
      const range = document.createRange();
      range.setStart(node, markerIndex);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    node = walker.nextNode();
  }
}

function deleteAdjacentMention(key: string): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const previous = key === 'Backspace';
  const target = adjacentMention(range, previous);
  if (!target) return false;
  const caret = document.createTextNode('');
  target.replaceWith(caret);
  range.setStart(caret, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function adjacentMention(range: Range, previous: boolean): HTMLElement | null {
  const container = range.startContainer;
  const offset = range.startOffset;
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? '';
    if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
    return findMentionSibling(container, previous);
  }
  const children = Array.from(container.childNodes);
  return findMentionSibling(children[previous ? offset - 1 : offset] ?? container, previous, true);
}

function findMentionSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
  let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
  while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent ?? '').trim()) {
    current = previous ? current.previousSibling : current.nextSibling;
  }
  return current instanceof HTMLElement && current.dataset.canvasMentionId ? current : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
