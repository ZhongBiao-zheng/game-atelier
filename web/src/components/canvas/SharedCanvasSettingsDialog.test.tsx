import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabCard } from '@/schema/collab';
import { SharedCanvasSettingsDialog } from './SharedCanvasSettingsDialog';
import { SharedCanvasPasscodeDialog } from './SharedCanvasPasscodeDialog';

const existing = {
  peer_key: 'self', project_id: 'canvas-a', name: '场景', display_name: '甲', is_self: true,
  mode: 'edit', requires_passcode: true, allow_borrow_provider: false, cover_version_id: null,
  online_count: 1, node_count: 2, updated_at: '', protocol_version: 1,
} satisfies CollabCard;
let displayName: string | null;
let writes: Array<[string, unknown]>;
beforeEach(() => {
  displayName = null;
  writes = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body) writes.push([url, JSON.parse(String(init.body))]);
    const payload = url === '/api/profile' ? {display_name: displayName} : {port: 5181, addresses: ['192.168.1.20']};
    return new Response(JSON.stringify(payload), {status: 200});
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('共享画布访问设置', () => {
  it('第一次开启共享时先保存团队显示名，再保存本画布权限和访问口令', async () => {
    const saved = vi.fn();
    render(<SharedCanvasSettingsDialog projectId="canvas-a" name="场景" onClose={vi.fn()} onSaved={saved} />);
    fireEvent.change(await screen.findByLabelText('你的团队显示名'), {target: {value: '房主'}});
    fireEvent.change(screen.getByLabelText('访问口令'), {target: {value: '测试'}});
    fireEvent.click(screen.getByRole('radio', {name: '仅查看'}));
    fireEvent.click(screen.getByRole('button', {name: '开始共享'}));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(writes).toEqual([
      ['/api/profile', {display_name: '房主'}],
      ['/api/collab/shares/canvas-a', {mode: 'view', allow_borrow_provider: false, passcode: '测试'}],
    ]);
  });

  it('修改共享权限时保留原口令，显式清除时发送空口令', async () => {
    displayName = '房主';
    const saved = vi.fn();
    const {unmount} = render(<SharedCanvasSettingsDialog projectId="canvas-a" name="场景" share={existing} onClose={vi.fn()} onSaved={saved} />);
    const submit = screen.getByRole('button', {name:'保存设置'});
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(writes.at(-1)?.[1]).not.toHaveProperty('passcode');
    unmount();
    render(<SharedCanvasSettingsDialog projectId="canvas-a" name="场景" share={existing} onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', {name:'修改或清除口令'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'保存设置'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'保存设置'}));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
    expect(writes.at(-1)?.[1]).toHaveProperty('passcode', '');
  });

  it('访客首次进入受保护画布时同时填写署名与口令', async () => {
    const entered = vi.fn();
    render(<SharedCanvasPasscodeDialog peerKey="host" projectId="canvas-a" name="场景" needsName needsCode
      onClose={vi.fn()} onEntered={entered} />);
    const enter = screen.getByRole('button', {name:'进入画布'});
    expect(enter).toBeDisabled();
    fireEvent.change(screen.getByLabelText('你的团队显示名'), {target:{value:'访客'}});
    fireEvent.change(screen.getByLabelText('访问口令'), {target:{value:'正确口令'}});
    fireEvent.click(enter);
    await waitFor(() => expect(entered).toHaveBeenCalledOnce());
    expect(writes).toEqual([['/api/profile', {display_name: '访客'}], ['/api/collab/remote/host/projects/canvas-a/auth', {passcode:'正确口令'}]]);
  });
});
