import { prefersReducedMotion, shakeOnError } from '@/lib/motion';

/** 平滑滚动大约用的时间（浏览器不报 smooth 滚完的时刻，scrollend 也不是处处都有）。 */
const SCROLL_SETTLE_MS = 300;

/** 表单提交校验失败时，把首个出错字段带到眼前：不在可见区就平滑滚到中间，到位后聚焦并水平微抖一次。
 *  字段本身的红框由 aria-invalid（INVALID_RING）负责；减弱动态效果时直接跳到位、不抖。 */
export function revealInvalidField(field: HTMLElement | null) {
  if (!field) return;
  const rect = field.getBoundingClientRect();
  const visible = rect.top >= 0 && rect.bottom <= window.innerHeight && isInsideScrollParent(field, rect);
  const settle = () => {
    field.focus({ preventScroll: true });
    shakeOnError(field);
  };
  if (visible) { settle(); return; }
  const smooth = !prefersReducedMotion();
  field.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'instant' });
  if (smooth) window.setTimeout(settle, SCROLL_SETTLE_MS);
  else settle();
}

function isInsideScrollParent(field: HTMLElement, rect: DOMRect) {
  let node = field.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      const box = node.getBoundingClientRect();
      return rect.top >= box.top && rect.bottom <= box.bottom;
    }
    node = node.parentElement;
  }
  return true;
}
