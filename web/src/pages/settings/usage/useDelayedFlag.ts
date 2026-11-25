import { useEffect, useState } from 'react';

/** 请求超过这个时长才给「正在刷新」的视觉反馈；快请求直接换数据，不闪一下半透明。 */
export const REFRESH_FEEDBACK_DELAY_MS = 150;

/** flag 持续为真超过 delay 才返回真；变假立即返回假。 */
export function useDelayedFlag(flag: boolean, delay = REFRESH_FEEDBACK_DELAY_MS): boolean {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!flag) {
      setDelayed(false);
      return;
    }
    const timer = window.setTimeout(() => setDelayed(true), delay);
    return () => window.clearTimeout(timer);
  }, [flag, delay]);
  return delayed;
}
