import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MANUAL from '../../../../src/character_workflow/data/http_protocol_manual.md?raw';
import { CustomInterfaceDialog } from './CustomInterfaceDialog';

const api = vi.hoisted(() => ({
  getHttpProtocol: vi.fn(),
  createHttpProtocol: vi.fn(),
  updateHttpProtocol: vi.fn(),
  validateHttpProtocol: vi.fn(async () => ({ valid: false, issues: [], declared: null, preview: null })),
}));
vi.mock('@/api/httpProtocols', () => api);

// 服务端「AI 帮我配置」读的是同一个文件（http_protocol_assist._manual_section）。

afterEach(() => { vi.restoreAllMocks(); });

/** jsdom 的 Blob 没有 text()，用 FileReader 读。 */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('复制接入说明', () => {
  it('copies the whole manual file to the clipboard and says so', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    // 「已复制」2 秒后自动恢复：把组件这一个定时器扣下由用例触发，不靠「2 秒内找到它」（其余定时器照常）。
    const held: Array<() => void> = [];
    const original = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 2000) { held.push(handler); return 0; }
      return original(handler, ms, ...rest);
    }) as typeof window.setTimeout);
    render(<CustomInterfaceDialog identifier={null} kind="image" onSaved={() => {}} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '复制接入说明' }));

    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(MANUAL);
    expect(MANUAL).toContain('## 模板规范（版本 1）');
    expect(held).toHaveLength(1);
    act(() => held[0]());
    expect(screen.getByRole('button', { name: '复制接入说明' })).toBeInTheDocument();
  });

  it('downloads the same file when the browser blocks the clipboard', async () => {
    const writeText = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const blobs: Blob[] = [];
    // jsdom 没有 createObjectURL / revokeObjectURL。
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:manual'; },
      revokeObjectURL: () => {},
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('Cobrush 自定义接口接入说明.md');
    });
    render(<CustomInterfaceDialog identifier={null} kind="image" onSaved={() => {}} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '复制接入说明' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('浏览器不允许写入剪贴板，已下载为文件');
    expect(click).toHaveBeenCalledTimes(1);
    expect(await readBlob(blobs[0])).toBe(MANUAL);
  });
});
