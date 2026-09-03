import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionPage } from './Connection';

const grant = { grant_id: 'g1', name: 'Codex 角色助手', project_ids: ['p1'], capabilities: ['read'], expires_at: '2099-01-01T00:00:00Z', credential_path: '/private/credentials/g1.json' };
function server(existing = false) {
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects') return new Response(JSON.stringify({ projects: [{ id: 'p1', name: '测试项目' }], assignments: {} }));
    if (url === '/api/canvas/project-options') return new Response(JSON.stringify([{ project_id: 'canvas-one', name: '测试画布' }]));
    if (url === '/api/connection/agent-grants' && init?.method === 'POST') return new Response(JSON.stringify(grant));
    if (url === '/api/connection/agent-grants/g1') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ grants: existing ? [grant] : [] }));
  });
  vi.stubGlobal('fetch', network); return network;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('local Agent authorization UI', () => {
  it('requires explicit projects and capabilities without granting generation approval', async () => {
    const network = server(); render(<ConnectionPage />);
    fireEvent.click(await screen.findByRole('button', { name: '添加 Agent 授权' }));
    const create = screen.getByRole('button', { name: '创建授权' }); expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: grant.name } });
    fireEvent.click(await screen.findByLabelText('测试项目'));
    fireEvent.click(screen.getByLabelText('准备生成（仍需你批准）'));
    fireEvent.click(create); await screen.findByText(grant.credential_path);
    const call = network.mock.calls.find(([url, init]) => url.endsWith('agent-grants') && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: grant.name, project_ids: ['p1'], canvas_project_ids: [], capabilities: ['read', 'prepare_generation'], days: 7 });
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });
  it('copies only the credential file path and revokes only after confirmation', async () => {
    const network = server(true); const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ConnectionPage />); await screen.findByText(grant.name);
    fireEvent.click(screen.getByRole('button', { name: `复制 ${grant.name} 凭据路径` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(grant.credential_path));
    fireEvent.click(screen.getByRole('button', { name: `撤销 ${grant.name}` }));
    expect(network.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: `撤销 ${grant.name}` }));
    await waitFor(() => expect(screen.queryByText(grant.name)).not.toBeInTheDocument());
  });
});
