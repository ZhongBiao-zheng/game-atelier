import { useEffect, useState } from 'react';

import { MOTION_DURATION, motionAvailable } from '@/lib/motion';

export type FadePresencePhase = 'entering' | 'shown' | 'leaving';

/** 不能套 AnimatePresence 的浮层（xyflow 的 NodeToolbar 自己决定挂不挂）自管延迟卸载：
 *  visible 变 true 时先以透明态挂上一帧再撤掉透明（150ms 淡入）；变 false 时先 150ms 淡出，播完才让它卸载。
 *  调用方拿 mounted 当真正的显示开关，按 phase 加透明度类（只动透明度，不碰 xyflow 写的定位 transform）。
 *  jsdom 没有 matchMedia：直接跟着 visible 走，测试里不会多出一个正在淡出的工具条。 */
export function useFadePresence(visible: boolean) {
  const animated = motionAvailable();
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<FadePresencePhase>(visible && animated ? 'entering' : 'shown');
  if (visible && !mounted) {
    setMounted(true);
    setPhase(animated ? 'entering' : 'shown');
  }
  if (visible && mounted && phase === 'leaving') setPhase('shown');
  if (!visible && mounted && phase !== 'leaving') {
    if (animated) setPhase('leaving');
    else setMounted(false);
  }
  useEffect(() => {
    if (phase !== 'leaving') return;
    const timer = window.setTimeout(() => setMounted(false), MOTION_DURATION.fast * 1000);
    return () => window.clearTimeout(timer);
  }, [phase]);
  useEffect(() => {
    if (phase !== 'entering') return;
    // 透明态先画出一帧，过渡才有起点。
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPhase('shown')); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [phase]);
  return { mounted, phase };
}
