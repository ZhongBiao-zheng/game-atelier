import { beforeEach, expect, it, vi } from 'vitest';
import { createAnnotatedGeneration, ensureAnnotatedInputs, ensureAnnotationRendered, type AnnotationDocumentBridge } from './annotationRendering';
import { uploadCanvasMedia } from '@/api/canvas';
import { composeAnnotatedImage } from './composeAnnotatedImage';
import type { CanvasDocument, CanvasGenerationDraft, CanvasImageNode, CanvasMediaVersion } from '@/schema/canvas';
vi.mock('@/api/canvas', () => ({ canvasMediaUrl: (_p: string, v: string) => `/media/${v}`, uploadCanvasMedia: vi.fn() }));
vi.mock('./composeAnnotatedImage', () => ({ composeAnnotatedImage: vi.fn() }));
const version: CanvasMediaVersion = { version_id: 'original', kind: 'image', path: 'uploads/original.png', width: 1024, height: 768,
  mime_type: 'image/png', bytes: 100, sha256: 'a'.repeat(64), created_at: '2026-10-24T00:00:00Z', origin: { kind: 'upload', upload_id: 'original' } };
const draft: CanvasGenerationDraft = { mode: 'image', model: 'gpt-image-2', alias: null, prompt: '', params: {}, input_policy: 'all_connected', updated_at: version.created_at };
let document: CanvasDocument, bridge: AnnotationDocumentBridge, revision: number, locked: boolean;
beforeEach(() => {
  vi.clearAllMocks(); revision = 0; locked = false;
  document = { schema_version: 2, project_id: 'canvas-test', revision: 0, updated_at: version.created_at,
    viewport: { x: 0, y: 0, zoom: 1 }, settings: { background: 'none', show_image_info: true, show_minimap: true }, nodes: [{ id: 'source', type: 'image', title: '原图', position: { x: 0, y: 0 }, z_index: 0,
      data: { current_version_id: 'original', generation_draft: null, active_run_id: null, display: { fit: 'contain', free_resize: false },
        annotation: { version_id: 'original', rendered_version_id: null, visible: false,
          elements: [{ id: 'rect', type: 'rect', color: '#F04438', x: 10, y: 10, width: 100, height: 100, stroke_width: 4 }] } } }],
    connections: [], content_versions: { original: version } };
  bridge = { projectId: document.project_id, current: () => document, revision: () => revision,
    setRevision: value => { revision = value; }, apply: vi.fn(next => { document = next; }), persist: vi.fn(async () => true),
    busy: () => locked, lock: value => { locked = value; } };
  vi.mocked(composeAnnotatedImage).mockResolvedValue(new File(['png'], 'annotation.png'));
  vi.mocked(uploadCanvasMedia).mockImplementation(async () => {
    const rendered = { ...version, version_id: `rendered-${revision + 1}` };
    return { version: rendered, document: { ...document, revision: revision + 1, content_versions: { ...document.content_versions, [rendered.version_id]: rendered } } } as Awaited<ReturnType<typeof uploadCanvasMedia>>;
  });
});
it('creates a generation node with annotated edge and preserves the source annotation', async () => {
  const id = await createAnnotatedGeneration(bridge, 'source', draft);
  expect(uploadCanvasMedia).toHaveBeenCalledTimes(1);
  expect(document.nodes).toHaveLength(2);
  expect(document.connections[0]).toMatchObject({ source_node_id: 'source', target_node_id: id, annotated: true });
  expect((document.nodes[1] as CanvasImageNode).data.generation_draft?.prompt).toBe('按图中标注修改，输出不保留标注。');
  expect((document.nodes[0] as CanvasImageNode).data.current_version_id).toBe('original');
  expect((document.nodes[0] as CanvasImageNode).data.annotation?.visible).toBe(false);
  expect(bridge.apply).toHaveBeenNthCalledWith(1, expect.anything(), false);
  expect(bridge.apply).toHaveBeenNthCalledWith(2, expect.anything(), true);
});
it('refreshes an invalidated composite before submission, and reuses it otherwise', async () => {
  const id = await createAnnotatedGeneration(bridge, 'source', draft);
  await ensureAnnotatedInputs(bridge, id); expect(uploadCanvasMedia).toHaveBeenCalledTimes(1);
  const annotation = (document.nodes[0] as CanvasImageNode).data.annotation!;
  annotation.rendered_version_id = null; annotation.elements[0].color = '#3B82F6';
  await ensureAnnotatedInputs(bridge, id);
  expect(uploadCanvasMedia).toHaveBeenCalledTimes(2);
  expect((document.nodes[0] as CanvasImageNode).data.annotation?.rendered_version_id).toBe('rendered-2');
  expect(bridge.persist).toHaveBeenCalled();
});
it('does not attach an outdated render if the user edits during composition', async () => {
  vi.mocked(composeAnnotatedImage).mockImplementation(async () => {
    (document.nodes[0] as CanvasImageNode).data.annotation!.elements[0].color = '#3B82F6';
    return new File(['png'], 'annotation.png');
  });
  await expect(ensureAnnotationRendered(bridge, 'source')).rejects.toThrow('标注已改变');
  expect((document.nodes[0] as CanvasImageNode).data.annotation?.rendered_version_id).toBeNull();
  expect(locked).toBe(false);
});
it('rejects cleared annotations without uploading', async () => {
  (document.nodes[0] as CanvasImageNode).data.annotation = null;
  await expect(ensureAnnotationRendered(bridge, 'source')).rejects.toThrow('标注已清空');
  expect(uploadCanvasMedia).not.toHaveBeenCalled();
});
