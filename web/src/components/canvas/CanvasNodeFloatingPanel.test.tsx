import { Profiler } from 'react';
import { act, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { expect, it, vi } from 'vitest';
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
