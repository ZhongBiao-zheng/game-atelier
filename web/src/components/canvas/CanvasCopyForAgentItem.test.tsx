import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CanvasCopyForAgentItem, canvasAgentPrompt } from './CanvasCopyForAgentItem';

afterEach(() => { vi.unstubAllGlobals(); });

it('copies a prompt that names the canvas and its project id', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  render(<DropdownMenu open><DropdownMenuTrigger>菜单</DropdownMenuTrigger><DropdownMenuContent>
    <CanvasCopyForAgentItem name="帕伯里" projectId="canvas-abcdefgh" />
  </DropdownMenuContent></DropdownMenu>);
  fireEvent.click(screen.getByRole('menuitem', { name: '复制给外部 Agent' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(canvasAgentPrompt('帕伯里', 'canvas-abcdefgh')));
  expect(await screen.findByRole('menuitem', { name: '已复制' })).toBeInTheDocument();
  expect(canvasAgentPrompt('帕伯里', 'canvas-abcdefgh')).toContain('project_id: canvas-abcdefgh');
});

it('says so when the browser refuses the clipboard', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); }) } });
  render(<DropdownMenu open><DropdownMenuTrigger>菜单</DropdownMenuTrigger><DropdownMenuContent>
    <CanvasCopyForAgentItem name="帕伯里" projectId="canvas-abcdefgh" />
  </DropdownMenuContent></DropdownMenu>);
  fireEvent.click(screen.getByRole('menuitem', { name: '复制给外部 Agent' }));
  expect(await screen.findByRole('menuitem', { name: '复制失败' })).toBeInTheDocument();
});
