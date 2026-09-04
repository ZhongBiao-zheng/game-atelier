import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SpecForm } from './SpecForm';

vi.mock('@/hooks/useClipboard', () => ({ useClipboard: () => async () => ({ success: true }) }));
const first = 'a'.repeat(64), second = 'b'.repeat(64), third = 'c'.repeat(64);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('spec document revision safety', () => {
  it('submits the loaded revision and keeps a dirty draft based on that revision after SSE', async () => {
    let remote = { content: '磁盘初稿', revision: first };
    const network = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? json({ error: { code: 'DOCUMENT_CONFLICT', message: '文档已被其他编辑者修改' } }, 409) : json(remote));
    vi.stubGlobal('fetch', network);
    const { rerender } = render(<SpecForm characterId="bird" characterName="鸟" sseSignal={0} />);
    const editor = await screen.findByDisplayValue('磁盘初稿');
    fireEvent.change(editor, { target: { value: '我的未保存稿' } });
    remote = { content: 'MCP 写入内容', revision: second };
    rerender(<SpecForm characterId="bird" characterName="鸟" sseSignal={1} />);
    await screen.findByText('文件已变更');
    expect(editor).toHaveValue('我的未保存稿');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText(/文档已被其他编辑者修改/);
    const call = network.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ content: '我的未保存稿', expected_revision: first });
    expect(editor).toHaveValue('我的未保存稿');
    expect(screen.getByText('未保存')).toBeInTheDocument();
  });

  it('does not discard typing that happened while a save was in flight', async () => {
    let finish!: (response: Response) => void;
    const network = vi.fn((_url: string, init?: RequestInit) => init?.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(json({ content: '初稿', revision: first })));
    vi.stubGlobal('fetch', network); render(<SpecForm characterId="bird" characterName="鸟" sseSignal={0} />);
    const editor = await screen.findByDisplayValue('初稿'); fireEvent.change(editor, { target: { value: '第一次修改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.change(editor, { target: { value: '发送后继续打字' } });
    await act(async () => finish(json({ ok: true, revision: second })));
    expect(editor).toHaveValue('发送后继续打字'); expect(screen.getByText('未保存')).toBeInTheDocument();
    network.mockImplementation(async (_url, init) => init?.method === 'POST' ? json({ ok: true, revision: third }) : json({ content: '第一次修改', revision: second }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByText('未保存')).not.toBeInTheDocument());
    const call = network.mock.calls.filter(([, init]) => init?.method === 'POST').at(-1);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ content: '发送后继续打字', expected_revision: second });
  });

  it('requires confirmation before replacing unsaved content with the disk version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ content: '初稿', revision: first })));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SpecForm characterId="bird" characterName="鸟" sseSignal={0} />);
    const editor = await screen.findByDisplayValue('初稿'); fireEvent.change(editor, { target: { value: '未保存' } });
    fireEvent.click(screen.getByRole('button', { name: '刷新' })); expect(confirm).toHaveBeenCalled(); expect(editor).toHaveValue('未保存');
  });
});
