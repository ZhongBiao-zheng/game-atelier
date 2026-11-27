import { Profiler } from 'react';
import { act, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { expect, it, onTestFinished, vi } from 'vitest';
import * as motion from '@/lib/motion';
import { markCanvasNodesEntering } from './canvasNodeAttention';
import { CanvasNodeFloatingPanel } from './CanvasEditorViews';

it('follows viewport transforms without React commits or new layout reads', () => {
  const anchor = document.createElement('div');
  const measure = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(350, 40, 320, 176));
  const commits = vi.fn();
  let store: ReturnType<typeof useStoreApi>;
  function Fixture() {
    store = useStoreApi();
    return <Profiler id="panel" onRender={commits}>
      <CanvasNodeFloatingPanel nodeId="fixture" anchor={anchor}>编辑</CanvasNodeFloatingPanel>
    </Profiler>;
  }
  render(<ReactFlowProvider><Fixture /></ReactFlowProvider>);
  commits.mockClear();
  measure.mockClear();
  for (let n = 1; n <= 10; n++) {
    act(() => store.setState({ transform: [n, 2 * n, 1 + n / 100] }));
  }
  expect(document.querySelector<HTMLElement>('[data-canvas-node-panel-anchor]')!.style.transform).toMatch(/translate3d/);
  expect(commits).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();
});

it('publishes each side change once, preserving the first entrance and the user’s focus', async () => {
  const anchor = document.createElement('div');
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(350, 40, 320, 176));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
  vi.spyOn(motion, 'motionAvailable').mockReturnValue(true);
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const stop = vi.fn();
  const animate = vi.spyOn(motion, 'animate').mockReturnValue({ finished, stop } as unknown as ReturnType<typeof motion.animate>);
  onTestFinished(() => { vi.restoreAllMocks(); });
  markCanvasNodesEntering(['new-image'], 0.92, 'left');
  const commits = vi.fn(), changed = vi.fn();
  let store: ReturnType<typeof useStoreApi>;
  function Fixture() {
    store = useStoreApi();
    return <Profiler id="panel" onRender={commits}>
      <CanvasNodeFloatingPanel nodeId="new-image" anchor={anchor} onSideChange={changed}>
        <div contentEditable aria-label="提示词" />
      </CanvasNodeFloatingPanel>
    </Profiler>;
  }
  const { getByLabelText, getByRole } = render(<ReactFlowProvider>
    <Fixture /><button>其他操作</button>
  </ReactFlowProvider>);
  const move = (y: number) => act(() => store.setState({ transform: [0, y, 1] }));
  const nearBottom = window.innerHeight - 260;
  expect(changed.mock.calls).toEqual([['below']]);
  move(nearBottom);
  expect(changed.mock.calls).toEqual([['below'], ['above']]);
  expect(stop).not.toHaveBeenCalled();
  await act(async () => { finish(); await finished; });
  expect(getByLabelText('提示词')).toHaveFocus();
  const other = getByRole('button');
  other.focus();
  commits.mockClear();
  move(nearBottom + 5);
  move(nearBottom + 10);
  expect(commits).not.toHaveBeenCalled();
  move(0);
  expect(changed.mock.calls).toEqual([['below'], ['above'], ['below']]);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(other).toHaveFocus();
});

it('writes the measured base coordinates in the same resize callback that clears translation', () => {
  let resize!: () => void;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const anchor = document.createElement('div');
  const rect = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(350, 40, 320, 176));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(160);
  onTestFinished(() => { vi.restoreAllMocks(); });
  let store: ReturnType<typeof useStoreApi>;
  function Fixture() {
    store = useStoreApi();
    return <CanvasNodeFloatingPanel nodeId="resized" anchor={anchor}>编辑</CanvasNodeFloatingPanel>;
  }
  render(<ReactFlowProvider><Fixture /></ReactFlowProvider>);
  const panel = document.querySelector<HTMLElement>('[data-canvas-node-panel-anchor="resized"]')!;
  const left = parseFloat(panel.style.left), top = parseFloat(panel.style.top);
  act(() => store.setState({ transform: [10, 20, 1] }));
  expect(panel.style.transform).toBe('translate3d(10px, 20px, 0)');
  rect.mockReturnValue(new DOMRect(360, 60, 320, 176));
  act(() => {
    resize();
    expect(panel.style.transform).toBe('');
    expect(parseFloat(panel.style.left)).toBe(left + 10);
    expect(parseFloat(panel.style.top)).toBe(top + 20);
  });
});
