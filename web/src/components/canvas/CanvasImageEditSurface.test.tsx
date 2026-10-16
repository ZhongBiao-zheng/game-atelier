import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { CanvasImageEditNode, CanvasMediaVersion } from '@/schema/canvas';
import { CanvasImageEditSurface } from './CanvasImageEditSurface';
import { initialEditFrame, savedImageEditError } from './imageEditGeometry';
import type { KeyView } from '@/api/keys';

const source: CanvasMediaVersion = { version_id: 'fixed', kind: 'image', path: 'source.png', mime_type: 'image/png',
  bytes: 100, width: 200, height: 100, sha256: 'a'.repeat(64), created_at: '', origin: { kind: 'upload', upload_id: 'source' } };
const node: CanvasImageEditNode = { id: 'edit', type: 'image_edit', title: '局部编辑', position: { x: 0, y: 0 }, z_index: 0,
  data: { source_node_id: null, source_version_id: 'fixed', reference_node_id: null, reference_version_id: null,
    mask_version_id: 'mask', active_run_id: null, generation_draft: { mode: 'image', alias: 'evo', model: 'mj-v8.2', prompt: '换成法杖',
      input_policy: 'all_connected', params: { n: 4 }, updated_at: '' }, options: { mode: 'inpaint' },
    editor_state: { frame_ratio: '', frame: { width: 400, height: 300, x: 70, y: 80 }, strokes: [
      { tool: 'brush', size: 20, points: [{ x: 20, y: 30 }] },
      { tool: 'eraser', size: 10, points: [{ x: 20, y: 30 }] },
    ] },
  } };
const key = { alias: 'evo', provider: 'evolink', models: [{ id: 'mj-v8.2', protocol: 'evolink', modality: 'image' }] } as KeyView;

it('preserves large source frames and limits their initial expansion', () => {
  expect(initialEditFrame(12000, 1000, 'inpaint')).toEqual({ width: 12000, height: 1000, x: 0, y: 0 });
  const expanded = initialEditFrame(12000, 1000, 'outpaint');
  expect(expanded.width).toBeLessThanOrEqual(16384);
  expect(expanded.width * expanded.height).toBeLessThanOrEqual(16_777_216);
  expect(expanded.width).toBeGreaterThanOrEqual(12000);
  expect(expanded.height).toBeGreaterThanOrEqual(1000);
  expect(initialEditFrame(16384, 1024, 'outpaint')).toEqual({ width: 16384, height: 1024, x: 0, y: 0 });
  expect(initialEditFrame(20000, 1000, 'inpaint')).toEqual({ width: 20000, height: 1000, x: 0, y: 0 });
  expect(initialEditFrame(20000, 1000, 'outpaint')).toEqual({ width: 20000, height: 1000, x: 0, y: 0 });
});

it('previews single-point brush and eraser strokes against the fixed original', () => {
  const { container } = render(<CanvasImageEditSurface node={node} source={source} projectId="p" />);
  expect(screen.getByRole('img', { name: '局部编辑 编辑预览' })).toHaveAttribute('viewBox', '0 0 200 100');
  expect(container.querySelector('image')).toHaveAttribute('href', '/api/canvas/projects/p/versions/fixed/media?w=1024');
  expect([...container.querySelectorAll('circle')].map(circle => [circle.getAttribute('r'), circle.getAttribute('fill')]))
    .toEqual([['10', 'white'], ['5', 'black']]);
});

it('previews an expanded frame without stretching the source', () => {
  const { container } = render(<CanvasImageEditSurface node={{ ...node, data: { ...node.data, options: { mode: 'outpaint' } } }} source={source} projectId="p" />);
  expect(screen.getByRole('img')).toHaveAttribute('viewBox', '0 0 400 300');
  expect(container.querySelector('g')).toHaveAttribute('transform', 'translate(70 80)');
  expect(container.querySelector('image')).toHaveAttribute('width', '200');
  expect(container.querySelector('image')).toHaveAttribute('height', '100');
});

it('checks saved-node generation before making a run request', () => {
  expect(savedImageEditError(node, source, [key])).toBeNull();
  expect(savedImageEditError({ ...node, data: { ...node.data, mask_version_id: null } }, source, [key])).toContain('区域');
  expect(savedImageEditError({ ...node, data: { ...node.data, generation_draft: null } }, source, [key])).toContain('模型');
  expect(savedImageEditError(node, undefined, [key])).toContain('源图片');
  const expanded = { ...node, data: { ...node.data, options: { mode: 'outpaint' as const, width: 400, height: 100, x: 100, y: 0 } } };
  expect(savedImageEditError(expanded, source, [key])).toBeNull();
  expect(savedImageEditError({ ...expanded, data: { ...expanded.data, options: { ...expanded.data.options, x: 300 } } }, source, [key])).toContain('完整包含');
});
