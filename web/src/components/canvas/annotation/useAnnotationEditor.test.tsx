import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAnnotationEditor } from './useAnnotationEditor';
import { AnnotationEditingLayer } from './AnnotationEditingLayer';
import { AnnotationToolbar } from './AnnotationToolbar';
import type { AnnotationElement } from './annotationModel';
const commit = vi.fn();
function Harness() {
  const [elements, setElements] = useState<AnnotationElement[]>([]);
  const editor = useAnnotationEditor({ enabled: true, elements, width: 1024, height: 768,
    onCommit: next => { commit(next); setElements(next); }, onExit: vi.fn(), undo: vi.fn(), redo: vi.fn(), onError: vi.fn() });
  return <><button onClick={() => editor.chooseTool('text')}>文字</button><button onClick={() => editor.chooseTool('select')}>选择</button>
    <button onClick={() => editor.chooseTool('rect')}>矩形</button>
    <button onClick={() => setElements(items => items.map(item => item.type === 'text' ? item : { ...item, stroke_width: 4 }))}>还原线宽</button>
    <AnnotationToolbar editor={editor} undo={vi.fn()} redo={vi.fn()} canUndo={false} canRedo={false} />
    <button onClick={() => editor.changeStyle({ color: '#3B82F6' })}>蓝</button>
    <AnnotationEditingLayer editor={editor} width={1024} height={768} fit="contain" /></>;
}
beforeEach(() => {
  commit.mockClear(); localStorage.clear();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('DOMPoint', class { constructor(public x: number, public y: number) {} matrixTransform() { return this; } });
  Object.defineProperty(SVGElement.prototype, 'getScreenCTM', { configurable: true, value: () => ({ a: 1, b: 0, inverse: () => ({}) }) });
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(SVGElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: () => ({ width: 40 }) } as unknown as CanvasRenderingContext2D);
});
function draw(svg: Element, start: number, end: number) {
  fireEvent.pointerDown(svg, { clientX: start, clientY: start, pointerId: 1, button: 0 });
  fireEvent.pointerMove(svg, { clientX: end, clientY: end, pointerId: 1, button: 0 });
  expect(commit).toHaveBeenCalledTimes(0);
  fireEvent.pointerUp(svg, { clientX: end, clientY: end, pointerId: 1, button: 0 });
}
it('commits each completed stroke once and selected style/delete affect only that element', () => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  draw(svg, 10, 100); expect(commit).toHaveBeenCalledTimes(1);
  commit.mockClear(); fireEvent.click(screen.getByText('矩形')); draw(svg, 200, 300); expect(commit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('选择'));
  fireEvent.pointerDown(svg, { clientX: 30, clientY: 30, pointerId: 1, button: 0 });
  fireEvent.pointerUp(svg, { clientX: 30, clientY: 30, pointerId: 1, button: 0 });
  fireEvent.click(screen.getByText('蓝'));
  expect(commit.mock.lastCall?.[0].map((e: AnnotationElement) => e.color)).toEqual(['#3B82F6', '#F04438']);
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(commit.mock.lastCall?.[0]).toHaveLength(1);
});
it('keeps IME composition and app blur separate from explicit text commit', () => {
  const { container } = render(<Harness />); fireEvent.click(screen.getByText('文字'));
  fireEvent.pointerDown(container.querySelector('[data-annotation-surface] svg')!, { clientX: 30, clientY: 30, button: 0 });
  const input = screen.getByRole('textbox', { name: '标注文字' });
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: '帽子改红' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); fireEvent.blur(input);
  expect(commit).not.toHaveBeenCalled(); expect(input).toBeInTheDocument();
  fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter' });
  expect(commit).toHaveBeenCalledTimes(1); expect(commit.mock.lastCall?.[0][0].text).toBe('帽子改红');
  fireEvent.click(screen.getByText('文字'));
  fireEvent.pointerDown(container.querySelector('[data-annotation-surface] svg')!, { clientX: 50, clientY: 50, button: 0 });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(commit).toHaveBeenCalledTimes(1);
});

it('discards tiny new shapes without adding undo history', () => {
  const { container } = render(<Harness />);
  draw(container.querySelector('[data-annotation-surface] svg')!, 10, 10.5);
  expect(commit).not.toHaveBeenCalled();
});

it('selects the completed shape immediately for width changes and movement', () => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  draw(svg, 10, 100);
  expect(screen.getByRole('button', { name: '选择 V' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '线宽' }));
  fireEvent.click(screen.getByRole('button', { name: '线宽 8' }));
  expect(commit.mock.lastCall?.[0][0].stroke_width).toBe(8);
  fireEvent.click(screen.getByRole('button', { name: '线宽' }));
  commit.mockClear();
  fireEvent.pointerDown(svg, { clientX: 30, clientY: 30, button: 0 });
  fireEvent.pointerMove(svg, { clientX: 50, clientY: 60, button: 0 });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(svg, { clientX: 50, clientY: 60, button: 0 });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.lastCall?.[0][0]).toMatchObject({ x: 30, y: 40, stroke_width: 8 });
  fireEvent.click(screen.getByText('还原线宽'));
  expect(screen.getByRole('button', { name: '线宽' })).toHaveTextContent('线宽4');
});
it('shows no input frame and scales selected text from a corner in one commit', () => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  fireEvent.click(screen.getByText('文字'));
  fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, button: 0 });
  const input = screen.getByRole('textbox');
  expect(input).toHaveClass('border-0');
  fireEvent.change(input, { target: { value: '改成红色' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(svg.querySelector('[data-annotation-resize]')).toBeNull();
  fireEvent.pointerDown(svg, { clientX: 110, clientY: 110, button: 0 });
  fireEvent.pointerUp(svg, { clientX: 110, clientY: 110, button: 0 });
  const corner = svg.querySelector('[data-annotation-resize="1-1"]')!;
  expect(corner).not.toBeNull();
  commit.mockClear();
  fireEvent.pointerDown(corner, { clientX: 144, clientY: 127.4, button: 0 });
  fireEvent.pointerMove(svg, { clientX: 184, clientY: 150.8, button: 0 });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(svg, { clientX: 184, clientY: 150.8, button: 0 });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.lastCall?.[0][0]).toMatchObject({ x: 100, y: 100, font_size: 36 });
});
