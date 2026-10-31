import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';

/** 悬停元素，返回 components/ui/tooltip 的 Hint 弹出的提示（role="tooltip"）。假计时器下自行推进打开延迟。 */
export async function hoverHint(element: HTMLElement) {
  fireEvent.pointerMove(element);
  if (!vi.isFakeTimers()) return screen.findByRole('tooltip');
  // findBy 的轮询本身也跑在假计时器上，会一直等不到：推进延迟后同步取。
  await act(() => vi.advanceTimersByTimeAsync(400));
  return screen.getByRole('tooltip');
}

/** 在弹层外按下指针。Radix 在弹层挂载后的下一拍才开始监听外部点击，先等一拍。 */
export async function pointerDownOutside() {
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  fireEvent.pointerDown(document.body);
}
