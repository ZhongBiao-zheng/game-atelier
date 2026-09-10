import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Dialog } from '@/components/ui/dialog';
import type { CanvasContentVersion, CanvasLayerStackNode } from '@/schema/canvas';
import { CanvasLayerStackComposite, CanvasLayerStackPreview } from './CanvasLayerStackPreview';

const image: CanvasContentVersion = { version_id: 'image', kind: 'image', created_at: '2026-09-10T00:00:00Z',
  sha256: 'a'.repeat(64), origin: { kind: 'upload', upload_id: 'upload' },
  path: 'image.png', mime_type: 'image/png', bytes: 1024, width: 600, height: 400 };
const node: CanvasLayerStackNode = { id: 'stack', type: 'layer_stack', title: '图层详情', position: { x: 0, y: 0 }, z_index: 0,
  data: { source_version_id: 'image', base_version_id: null, base_visible: true, alias: null, model: null,
    prompt: '', resolution: 'auto', layers: [], active_run_id: null, error: null } };
const resolveVersion = (id: string | null | undefined) => id === 'image' ? image : undefined;

it('shows the complete user prompt as read-only text in details', () => {
  const prompt = '分离角色、衣服与武器。\n保留透明背景和原始颜色。';
  render(<Dialog open><CanvasLayerStackPreview node={{ ...node, data: { ...node.data, prompt, base_version_id: 'image' } }}
    projectId="canvas-test" resolveVersion={resolveVersion} onCloseAutoFocus={() => undefined} /></Dialog>);
  const content = screen.getByLabelText('拆分提示词');
  expect(content.textContent).toBe(prompt);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看图层 背景' }));
  expect(screen.getByLabelText('拆分提示词').textContent).toBe(prompt);
});

it('does not invent a user prompt when none was entered', () => {
  render(<Dialog open><CanvasLayerStackPreview node={node} projectId="canvas-test" resolveVersion={resolveVersion}
    onCloseAutoFocus={() => undefined} /></Dialog>);
  expect(screen.getByLabelText('拆分提示词')).toHaveTextContent('未填写提示词');
});

it('previews the source before decomposition and reports an unreadable original', () => {
  render(<Dialog open><CanvasLayerStackPreview node={node} projectId="canvas-test" resolveVersion={resolveVersion}
    onCloseAutoFocus={() => undefined} /></Dialog>);
  expect(screen.getByText('尚未拆分')).toBeTruthy();
  expect(screen.getByRole('img', { name: '原图' })).toHaveAttribute('src', '/api/canvas/projects/canvas-test/versions/image/media');
  expect(screen.getByText('600 × 400')).toBeTruthy();
  fireEvent.error(screen.getByRole('img', { name: '原图' }));
  expect(screen.getByText('图片不可用')).toBeTruthy();
});

it('shows a missing-version message instead of an empty preview', () => {
  render(<Dialog open><CanvasLayerStackPreview node={node} projectId="canvas-test" resolveVersion={() => undefined}
    onCloseAutoFocus={() => undefined} /></Dialog>);
  expect(screen.getByText('图片不可用')).toBeTruthy();
  expect(screen.queryByRole('link', { name: '下载原图' })).toBeNull();
});

it('does not disguise a missing decomposition result as the source image', () => {
  render(<Dialog open><CanvasLayerStackPreview node={{ ...node, data: { ...node.data, base_version_id: 'missing' } }}
    projectId="canvas-test" resolveVersion={resolveVersion} onCloseAutoFocus={() => undefined} /></Dialog>);
  expect(screen.getByText('图片不可用')).toBeTruthy();
  expect(screen.queryByRole('img', { name: '原图' })).toBeNull();
});

it('uses the canvas painter order, visibility and bounding boxes', () => {
  const stack: CanvasLayerStackNode = { ...node, data: { ...node.data, base_version_id: 'image', base_z_index: 2,
    layout_size: { width: 900, height: 700 }, layers: [
      { id: 'front', name: '前层', description: '', version_id: 'image', visible: true, z_index: 3,
        bounding_box: { absolute: [10, 20, 110, 220], normalized: [0, 0, 1000, 1000] } },
      { id: 'hidden', name: '隐藏层', description: '', version_id: 'image', visible: false, z_index: 4,
        bounding_box: { absolute: [0, 0, 100, 100], normalized: [0, 0, 1000, 1000] } },
      { id: 'back', name: '后层', description: '', version_id: 'image', visible: true, z_index: 1,
        bounding_box: { absolute: [0, 0, 100, 100], normalized: [0, 0, 1000, 1000] } },
    ] } };
  render(<CanvasLayerStackComposite node={stack} projectId="canvas-test" resolveVersion={resolveVersion} />);
  const svg = screen.getByRole('img');
  expect(svg).toHaveAttribute('viewBox', '0 0 900 700');
  expect(Array.from(svg.querySelectorAll('image')).map(part => part.getAttribute('data-layer-stack-part'))).toEqual(['back', 'base', 'front']);
  expect(svg.querySelector('[data-layer-stack-part="front"]')).toHaveAttribute('width', '100');
  expect(svg.querySelector('[data-layer-stack-part="front"]')).toHaveAttribute('height', '200');
  fireEvent.error(svg.querySelector('[data-layer-stack-part="front"]')!);
  expect(screen.getByText('部分图层不可用')).toBeTruthy();
  fireEvent.load(svg.querySelector('[data-layer-stack-part="front"]')!);
  expect(screen.queryByText('部分图层不可用')).toBeNull();
});
