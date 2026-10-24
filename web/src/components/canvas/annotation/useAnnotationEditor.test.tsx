import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAnnotationEditor } from './useAnnotationEditor';
import { AnnotationSurfaceView } from './AnnotationSurfaceView';
import type { AnnotationElement } from './annotationModel';
const commit = vi.fn();
function Harness() {
  const [elements, setElements] = useState<AnnotationElement[]>([]);
  const editor = useAnnotationEditor({ enabled: true, elements, width: 1024, height: 768,
    onCommit: next => { commit(next); setElements(next); }, onExit: vi.fn(), undo: vi.fn(), redo: vi.fn(), onError: vi.fn() });
  return <><button onClick={() => editor.chooseTool('text')}>文字</button><button onClick={() => editor.chooseTool('select')}>选择</button>
    <button onClick={() => editor.changeStyle({ color: '#3B82F6' })}>蓝</button>
    <AnnotationSurfaceView editor={editor} width={1024} height={768} fit="contain" /></>;
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
  const { container } = render(<Harness />); const svg = container.querySelector('svg')!;
  draw(svg, 10, 100); expect(commit).toHaveBeenCalledTimes(1);
  commit.mockClear(); draw(svg, 200, 300); expect(commit).toHaveBeenCalledTimes(1);
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
  fireEvent.pointerDown(container.querySelector('svg')!, { clientX: 30, clientY: 30, button: 0 });
  const input = screen.getByRole('textbox', { name: '标注文字' });
  fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: '帽子改红' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); fireEvent.blur(input);
  expect(commit).not.toHaveBeenCalled(); expect(input).toBeInTheDocument();
  fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter' });
  expect(commit).toHaveBeenCalledTimes(1); expect(commit.mock.lastCall?.[0][0].text).toBe('帽子改红');
  fireEvent.pointerDown(container.querySelector('svg')!, { clientX: 50, clientY: 50, button: 0 });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(commit).toHaveBeenCalledTimes(1);
});
