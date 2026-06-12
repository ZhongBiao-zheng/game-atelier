import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ResizableDivider } from './ResizableDivider';

beforeEach(() => {
  // jsdom 不实现 pointer capture
  Element.prototype.setPointerCapture = vi.fn();
});

function setup(props: Partial<Parameters<typeof ResizableDivider>[0]> = {}) {
  const onResize = vi.fn();
  const onCommit = vi.fn();
  render(
    <div className="relative">
      <ResizableDivider
        width={264}
        min={200}
        max={400}
        onResize={onResize}
        onCommit={onCommit}
        label="调整名册宽度"
        {...props}
      />
    </div>,
  );
  return { divider: screen.getByRole('separator', { name: props.label ?? '调整名册宽度' }), onResize, onCommit };
}

// jsdom 无 PointerEvent，RTL 合成事件会丢 clientX —— 用 MouseEvent 构造同名事件
function firePointer(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, clientX }));
}

describe('ResizableDivider', () => {
  it('clamps to min without snap — 名册栏拖到边缘也不收起', () => {
    const { divider, onResize, onCommit } = setup();
    firePointer(divider, 'pointerdown', 264);
    // jsdom 宿主 rect 全 0，clientX 即相对 x
    firePointer(divider, 'pointermove', 10);
    expect(onResize).toHaveBeenLastCalledWith(200);
    firePointer(divider, 'pointermove', 500);
    expect(onResize).toHaveBeenLastCalledWith(400);
    firePointer(divider, 'pointerup', 500);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // 同帧 move+up：commit 必须拿到 move 刚拖出的宽度，而非渲染期的旧 width prop
    expect(onCommit).toHaveBeenCalledWith(400);
  });

  it('snaps to 0 below the snap threshold — 胶片带可收起', () => {
    const { divider, onResize } = setup({ width: 104, min: 72, max: 320, snap: 64, label: '调整胶片带宽度' });
    firePointer(divider, 'pointerdown', 104);
    firePointer(divider, 'pointermove', 40);
    expect(onResize).toHaveBeenLastCalledWith(0);
    firePointer(divider, 'pointermove', 90);
    expect(onResize).toHaveBeenLastCalledWith(90);
  });
});
