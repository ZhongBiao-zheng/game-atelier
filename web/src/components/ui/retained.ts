import { useRef } from 'react';

/** 受控弹窗的内容缓存：value 变成 null / undefined（弹窗关闭）后仍返回最后一份非空值，
 *  让 Radix 的退场动画带着原内容播完，不在关闭那一帧变空或闪成别的样子。
 *  用法：open={Boolean(value)}，内容读 useRetained(value)。 */
export function useRetained<T>(value: T | null | undefined): T | null {
  const kept = useRef<T | null>(null);
  if (value != null) kept.current = value;
  return value ?? kept.current;
}

/** 同 useRetained，另带一个会话号：value 换成新的一份（打开了另一次）时加一，作弹窗内容的 key，
 *  再次打开时表单状态从头来，关闭期间沿用上一份播完退场。value 必须是 state 里的值，不能每次渲染新建。 */
export function useRetainedSession<T>(value: T | null | undefined): { value: T; session: number } | null {
  const kept = useRef<{ value: T; session: number } | null>(null);
  // 关了再开同一个值（比如同一类接口）也算新的一次。
  const wasOpen = useRef(false);
  if (value != null && (!wasOpen.current || !Object.is(value, kept.current?.value))) {
    kept.current = { value, session: (kept.current?.session ?? 0) + 1 };
  }
  wasOpen.current = value != null;
  return kept.current;
}
