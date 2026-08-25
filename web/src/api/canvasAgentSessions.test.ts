import { afterEach, expect, it, vi } from 'vitest';

import {
  createCanvasAgentSession,
  deleteCanvasAgentSession,
  getCanvasAgentSession,
  listCanvasAgentSessions,
} from './canvas';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('uses project-scoped session routes and revision-safe deletion', async () => {
  const session = {
    schema_version: 1 as const,
    revision: 2,
    sequence: 3,
    session_id: 'session-12345678',
    project_id: 'canvas-project-1234',
    title: '分镜对话',
    status: 'idle' as const,
    model: null,
    effort: null,
    token_usage: { input_tokens: 12, output_tokens: 20 },
    messages: [],
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:01:00Z',
  };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      sessions: [{
        session_id: session.session_id,
        project_id: session.project_id,
        title: session.title,
        status: session.status,
        revision: session.revision,
        sequence: session.sequence,
        message_count: 0,
        created_at: session.created_at,
        updated_at: session.updated_at,
      }],
      corrupt_session_ids: [],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);

  await listCanvasAgentSessions('canvas/project');
  await createCanvasAgentSession('canvas/project', '分镜对话');
  await getCanvasAgentSession('canvas/project', 'session/id');
  await deleteCanvasAgentSession('canvas/project', 'session/id', 2);

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    '/api/canvas/projects/canvas%2Fproject/agent/sessions',
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    '/api/canvas/projects/canvas%2Fproject/agent/sessions',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: '分镜对话' }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    '/api/canvas/projects/canvas%2Fproject/agent/sessions/session%2Fid',
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    '/api/canvas/projects/canvas%2Fproject/agent/sessions/session%2Fid',
    { method: 'DELETE', headers: { 'If-Match': '2' } },
  );
});
