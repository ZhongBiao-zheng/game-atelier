import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolbarPopover } from './ToolbarPopover';

let anchorRect: DOMRect;
let contentHeight: number;
let resize: () => void;
let frame: FrameRequestCallback;

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

function Harness({ onClose = vi.fn(), container = false }: { onClose?: () => void; container?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const portal = useRef<HTMLDivElement>(null);
  return <div ref={portal} data-testid="portal">
    <button ref={anchor} data-testid="anchor">菜单</button>
    <ToolbarPopover open onClose={onClose} anchorRef={anchor} autoFocus
      portalContainerRef={container ? portal : undefined} data-testid="menu">
      <div><button>第一项</button><button>第二项</button></div>
    </ToolbarPopover>
  </div>;
}

beforeEach(() => {
  anchorRect = rect(650, 400, 100, 40);
  contentHeight = 200;
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'anchor') return anchorRect;
    if (this.dataset.testid === 'portal') return rect(100, 50, 600, 400);
    return rect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'portal') return 600;
    return this.dataset.testid === 'menu' ? Math.min(320, parseFloat(this.style.maxWidth) || 320) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'portal') return 400;
    return this.dataset.testid === 'menu' ? Math.min(contentHeight, parseFloat(this.style.maxHeight) || contentHeight) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.offsetHeight; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'menu' ? contentHeight : this.clientHeight;
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ToolbarPopover positioning lifecycle', () => {
  it('measures synchronously, clamps width and retains focus / dismissal behavior', () => {
    const close = vi.fn();
    render(<Harness onClose={close} />);
    const panel = screen.getByTestId('menu');
    expect(panel).toHaveStyle({ position: 'fixed', left: '468px', bottom: '212px', maxHeight: '376px', maxWidth: '776px', overflow: 'auto' });
    expect(screen.getByRole('button', { name: '第一项' })).toHaveFocus();
    fireEvent.mouseDown(panel);
    fireEvent.mouseDown(screen.getByTestId('anchor'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('anchor')).toHaveFocus();
    fireEvent.mouseDown(document.body);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('repositions after content grows and shrinks without oscillating on capped height', () => {
    anchorRect = rect(100, 100, 100, 40);
    contentHeight = 50;
    render(<Harness />);
    const panel = screen.getByTestId('menu');
    expect(panel).toHaveAttribute('data-side', 'up');
    act(() => { contentHeight = 900; resize(); });
    expect(panel).toHaveAttribute('data-side', 'down');
    expect(panel).toHaveStyle({ top: '152px', maxHeight: '436px' });
    act(() => resize());
    expect(panel).toHaveAttribute('data-side', 'down');
    act(() => { contentHeight = 50; resize(); });
    expect(panel).toHaveAttribute('data-side', 'up');
  });

  it('tracks anchor movement without scroll events', () => {
    render(<Harness />);
    act(() => { anchorRect = rect(40, 80, 100, 40); frame(1); });
    expect(screen.getByTestId('menu')).toHaveStyle({ left: '40px', top: '132px' });
    expect(screen.getByTestId('menu')).toHaveAttribute('data-side', 'down');
  });

  it('responds to keyboard viewport resizing and panning', () => {
    const viewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
    vi.stubGlobal('visualViewport', viewport);
    render(<Harness />);
    act(() => { viewport.width = 375; viewport.height = 300; viewport.offsetTop = 100; viewport.dispatchEvent(new Event('resize')); });
    expect(screen.getByTestId('menu')).toHaveStyle({ left: '43px', maxWidth: '351px', maxHeight: '276px' });
    act(() => { viewport.offsetLeft = 40; viewport.dispatchEvent(new Event('scroll')); });
    expect(screen.getByTestId('menu')).toHaveStyle({ left: '83px' });
  });

  it('converts viewport bounds into a bordered, scrolled, scaled portal container', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'portal' ? rect(100, 50, 300, 200) : anchorRect;
    });
    vi.spyOn(HTMLElement.prototype, 'clientLeft', 'get').mockReturnValue(2);
    vi.spyOn(HTMLElement.prototype, 'clientTop', 'get').mockReturnValue(2);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'portal' ? 396 : this.offsetHeight;
    });
    render(<Harness container />);
    const portal = screen.getByTestId('portal');
    portal.scrollLeft = 10;
    portal.scrollTop = 20;
    fireEvent.scroll(portal);
    const panel = screen.getByTestId('menu');
    expect(portal).toContainElement(panel);
    expect(panel).toHaveStyle({ position: 'absolute', left: '1064px', bottom: '-298px', maxWidth: '1552px', maxHeight: '752px' });
  });
});
