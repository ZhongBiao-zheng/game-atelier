import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 50, pointerId: 1, button: 0 });
  fireEvent.pointerUp(svg, { clientX: 10, clientY: 50, pointerId: 1, button: 0 });
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
  fireEvent.pointerDown(container.querySelector('[data-annotation-surface] svg')!, { clientX: 200, clientY: 200, button: 0 });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(commit).toHaveBeenCalledTimes(1);
});

it('discards tiny new shapes without adding undo history', () => {
  const { container } = render(<Harness />);
  draw(container.querySelector('[data-annotation-surface] svg')!, 10, 10.5);
  expect(commit).not.toHaveBeenCalled();
});

it('keeps the drawing tool and selects the completed shape for width changes and movement', () => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  draw(svg, 10, 100);
  expect(screen.getByRole('radio', { name: '框选 R' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('button', { name: '线宽' }));
  fireEvent.click(screen.getByRole('button', { name: '线宽 8' }));
  expect(commit.mock.lastCall?.[0][0].stroke_width).toBe(8);
  fireEvent.click(screen.getByRole('button', { name: '线宽' }));
  commit.mockClear();
  fireEvent.pointerDown(svg, { clientX: 10, clientY: 40, button: 0 });
  fireEvent.pointerMove(svg, { clientX: 30, clientY: 70, button: 0 });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(svg, { clientX: 30, clientY: 70, button: 0 });
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

it.each([[0, 0], [0, 1], [1, 0], [1, 1]])('resizes a rectangle from corner %i,%i, preserving stroke and committing once', (cx, cy) => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  draw(svg, 10, 100);
  const handle = svg.querySelector(`[data-annotation-resize="${cx}-${cy}"]`)!;
  expect(handle).not.toBeNull();
  commit.mockClear();
  const x = cx ? 104 : 6, y = cy ? 104 : 6;
  const end = { clientX: x + (cx ? 20 : -20), clientY: y + (cy ? 30 : -30), button: 0 };
  fireEvent.pointerDown(handle, { clientX: x, clientY: y, button: 0 });
  fireEvent.pointerMove(svg, end);
  expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(svg, end);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.lastCall?.[0][0]).toMatchObject({ x: cx ? 10 : -10, y: cy ? 10 : -20, width: 110, height: 120, stroke_width: 4 });
});

it.each(['start', 'end'] as const)('drags the arrow %s independently and commits once', endpoint => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  fireEvent.click(screen.getByRole('radio', { name: '箭头 A' }));
  draw(svg, 10, 100);
  const handle = svg.querySelector(`[data-annotation-endpoint="${endpoint}"]`)!;
  expect(handle).not.toBeNull();
  const start = endpoint === 'start' ? 10 : 100;
  commit.mockClear();
  fireEvent.pointerDown(handle, { clientX: start, clientY: start, button: 0 });
  fireEvent.pointerMove(svg, { clientX: 180, clientY: 40, button: 0 });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(svg, { clientX: 180, clientY: 40, button: 0 });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.lastCall?.[0][0]).toMatchObject({
    start: endpoint === 'start' ? [180, 40] : [10, 10],
    end: endpoint === 'end' ? [180, 40] : [100, 100], stroke_width: 4,
  });
});
it('does not collapse an arrow to a zero-length endpoint edit', () => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  fireEvent.click(screen.getByRole('radio', { name: '箭头 A' })); draw(svg, 10, 100);
  const handle = svg.querySelector('[data-annotation-endpoint="end"]')!;
  expect(handle).not.toBeNull(); commit.mockClear();
  fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerUp(svg, { clientX: 10, clientY: 10, button: 0 });
  expect(commit).not.toHaveBeenCalled();
  expect(svg.querySelector('[data-annotation-endpoint="end"]')).toHaveAttribute('cx', '100');
});

it('moves an existing mark when pressed with a drawing tool and draws a new box inside another', () => {
  const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')!;
  draw(svg, 10, 100); commit.mockClear();
  fireEvent.pointerDown(svg, { clientX: 100, clientY: 50, button: 0 });
  fireEvent.pointerMove(svg, { clientX: 120, clientY: 60, button: 0 });
  fireEvent.pointerUp(svg, { clientX: 120, clientY: 60, button: 0 });
  expect(commit.mock.lastCall?.[0]).toHaveLength(1);
  expect(commit.mock.lastCall?.[0][0]).toMatchObject({ x: 30, y: 20, width: 90, height: 90 });
  commit.mockClear(); draw(svg, 50, 80);
  expect(commit.mock.lastCall?.[0]).toHaveLength(2);
  expect(screen.getByRole('radio', { name: '框选 R' })).toHaveAttribute('aria-checked', 'true');
});

it('shows a move cursor over a mark and adjusts its width with the wheel in one commit', () => {
  vi.useFakeTimers();
  try {
    const { container } = render(<Harness />); const svg = container.querySelector('[data-annotation-surface] svg')! as SVGSVGElement;
    draw(svg, 10, 100); commit.mockClear();
    fireEvent.pointerMove(svg, { clientX: 10, clientY: 50 });
    expect(svg.style.cursor).toBe('move');
    fireEvent.pointerMove(svg, { clientX: 50, clientY: 50 });
    expect(svg.style.cursor).toBe('crosshair');
    fireEvent.wheel(svg, { clientX: 50, clientY: 50, deltaY: -200 });
    fireEvent.wheel(svg, { clientX: 50, clientY: 50, deltaY: -200, ctrlKey: true });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(commit).not.toHaveBeenCalled();
    const scroll = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 10, clientY: 50, deltaY: -40 });
    act(() => { svg.dispatchEvent(scroll); });
    expect(scroll.defaultPrevented).toBe(true);
    act(() => { svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 10, clientY: 50, deltaY: -80 })); });
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '线宽' })).toHaveTextContent('线宽7');
    act(() => { vi.advanceTimersByTime(400); });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.lastCall?.[0][0].stroke_width).toBe(7);
  } finally { vi.useRealTimers(); }
});

it('shares tool and style choices between node editors', () => {
  render(<><Harness /><Harness /></>);
  fireEvent.click(screen.getAllByRole('radio', { name: '黄' })[0]);
  fireEvent.click(screen.getAllByRole('radio', { name: '箭头 A' })[0]);
  expect(screen.getAllByRole('radio', { name: '黄' })[1]).toHaveAttribute('aria-checked', 'true');
  expect(screen.getAllByRole('radio', { name: '箭头 A' })[1]).toHaveAttribute('aria-checked', 'true');
});
