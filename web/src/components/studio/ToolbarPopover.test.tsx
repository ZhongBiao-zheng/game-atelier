import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolbarPopover } from './ToolbarPopover';

function Harness({ onClose = vi.fn(), container = false, autoFocus = true }: {
  onClose?: () => void; container?: boolean; autoFocus?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const portal = useRef<HTMLDivElement>(null);
  return <div ref={portal} data-testid="portal">
    <button ref={anchor} data-testid="anchor">菜单</button>
    <ToolbarPopover open onClose={onClose} anchorRef={anchor} autoFocus={autoFocus} direction="down"
      portalContainerRef={container ? portal : undefined} data-testid="menu">
      <div><button>第一项</button><button>第二项</button></div>
    </ToolbarPopover>
  </div>;
}

describe('ToolbarPopover', () => {
  it('focuses the first item, keeps clicks on the panel and anchor, and returns focus on Escape', async () => {
    const close = vi.fn();
    render(<Harness onClose={close} />);
    const panel = screen.getByTestId('menu');
    expect(panel).toHaveAttribute('data-toolbar-popover');
    expect(panel).toHaveClass('z-50');
    expect(screen.getByRole('button', { name: '第一项' })).toHaveFocus();
    fireEvent.pointerDown(panel);
    fireEvent.pointerDown(screen.getByTestId('anchor'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(screen.getByTestId('anchor')).toHaveFocus();
  });

  it('closes on a pointer down outside', async () => {
    const close = vi.fn();
    render(<Harness onClose={close} />);
    // Radix 在挂载后的下一拍才开始监听外部点击
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves focus where it was when autoFocus is off and does not close on focus moving elsewhere', () => {
    const close = vi.fn();
    render(<Harness onClose={close} autoFocus={false} />);
    expect(screen.getByRole('button', { name: '第一项' })).not.toHaveFocus();
    act(() => screen.getByTestId('anchor').focus());
    expect(close).not.toHaveBeenCalled();
  });

  it('portals into the given container', async () => {
    render(<Harness container />);
    expect(screen.getByTestId('portal')).toContainElement(await screen.findByTestId('menu'));
  });
});

function Pair({ secondOpen, nested, close }: { secondOpen: boolean; nested: boolean; close: () => void }) {
  const a = useRef<HTMLButtonElement>(null);
  const b = useRef<HTMLButtonElement>(null);
  const second = <><button ref={b}>B anchor</button><ToolbarPopover open={secondOpen} onClose={() => {}} anchorRef={b}>B</ToolbarPopover></>;
  return <><button ref={a}>A anchor</button><ToolbarPopover open onClose={close} anchorRef={a}>A{nested && second}</ToolbarPopover>{!nested && second}</>;
}

it('closes an open sibling when another panel opens', () => {
  const close = vi.fn();
  const view = render(<Pair secondOpen={false} nested={false} close={close} />);
  view.rerender(<Pair secondOpen nested={false} close={close} />);
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps the parent open when a nested panel opens', () => {
  const close = vi.fn();
  const view = render(<Pair secondOpen={false} nested close={close} />);
  view.rerender(<Pair secondOpen nested close={close} />);
  expect(close).not.toHaveBeenCalled();
});
