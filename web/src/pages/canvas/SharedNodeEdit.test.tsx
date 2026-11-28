import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, CanvasTextNode, CanvasTextVersion } from '@/schema/canvas';
import { SharedNodeEdit } from './SharedNodeTools';

function state(title: string, text: string, revision: number) {
  const version: CanvasTextVersion = {
    kind: 'text', version_id: 'v' + revision, text, origin: { kind: 'user_edit' },
    created_at: 'now', sha256: '0'.repeat(64),
  };
  const node: CanvasTextNode = {
    type: 'text', id: 'note', title, position: { x: 0, y: 0 }, z_index: 0,
    data: { display: { scale: 'sm' }, current_version_id: version.version_id, generation_draft: null, active_run_id: null },
  };
  const doc: CanvasDocument = {
    project_id: 'canvas', revision, schema_version: 2, updated_at: 'now',
    nodes: [node], connections: [], content_versions: { [version.version_id]: version },
    settings: { background: 'dots', show_image_info: true, show_minimap: true }, viewport: { x: 0, y: 0, zoom: 1 },
  };
  return { node, doc };
}

describe('共享节点编辑', () => {
  it.each([false, true])('保留同时收到的正文，更改标题=%s', async editTitle => {
    const room = { connected: true, submitAndWait: vi.fn(async () => {}) };
    const close = vi.fn();
    const editor = (text: string, revision: number) =>
      <SharedNodeEdit open {...state('原标题', text, revision)} room={room} close={close} />;
    const { rerender } = render(editor('原文', 1));
    if (editTitle) fireEvent.change(screen.getByLabelText('标题'), { target: { value: '新标题' } });
    rerender(editor('对方刚保存的正文', 2));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    if (editTitle) expect(room.submitAndWait).toHaveBeenCalledWith({
      kind: 'node_update', node_id: 'note', patch: { title: '新标题' }, text_versions: [],
    }, 1);
    else expect(room.submitAndWait).not.toHaveBeenCalled();
  });
});
