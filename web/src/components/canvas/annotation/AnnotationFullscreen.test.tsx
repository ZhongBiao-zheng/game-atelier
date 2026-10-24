import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AnnotationFullscreen } from './AnnotationFullscreen';
import { useAnnotationEditor } from './useAnnotationEditor';
const { zoomBy, measure } = vi.hoisted(() => ({ zoomBy: vi.fn(), measure: vi.fn() }));
vi.mock('../ImageEditorShell', () => ({ useEditorViewport: () => ({ measure, zoomBy, scale: 1,
  origin: { x: 0, y: 0 }, startPan: vi.fn(), movePan: vi.fn(), endPan: vi.fn() }) }));
function Harness() {
  const editor = useAnnotationEditor({ enabled: true, elements: [], width: 1024, height: 768,
    onCommit: vi.fn(), onExit: vi.fn(), undo: vi.fn(), redo: vi.fn(), onError: vi.fn() });
  return <AnnotationFullscreen title="全屏验收" src="/image.png" width={1024} height={768} editor={editor}
    onCollapse={vi.fn()} undo={vi.fn()} redo={vi.fn()} canUndo={false} canRedo={false} />;
}
it('attaches wheel zoom after the dialog portal has mounted', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  render(<Harness />);
  const image = screen.getByRole('img', { name: '全屏验收' });
  fireEvent.wheel(image, { deltaY: -100 });
  expect(zoomBy).toHaveBeenCalledWith(Math.exp(.2));
  expect(screen.queryByRole('button', { name: '展开' })).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});
