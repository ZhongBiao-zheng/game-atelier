import { useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Agent 面板宽度：拖左边缘调整，跨刷新记住（只是本机偏好，存 localStorage）。 */
const STORAGE_KEY = 'canvas-agent-panel-width';
export const AGENT_PANEL_MIN_WIDTH = 384;  // 底栏一排按钮放得下的最小宽度
export const AGENT_PANEL_MAX_WIDTH = 800;
const DEFAULT_WIDTH = 400;
const KEYBOARD_STEP = 16;

function clamp(width: number): number {
  return Math.round(Math.min(Math.max(width, AGENT_PANEL_MIN_WIDTH), AGENT_PANEL_MAX_WIDTH));
}

function readWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clamp(value) : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

function writeWidth(width: number): void {
  try { window.localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* 无痕模式：只是下次不记得 */ }
}

export function useAgentPanelWidth() {
  const [width, setWidth] = useState(readWidth);

  /** 面板贴右边，往左拖变宽。提交用拖动过程里的最后一个值，不读可能过期的 state。 */
  function startResize(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      latest = clamp(startWidth + startX - moveEvent.clientX);
      setWidth(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      writeWidth(latest);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function resizeByKey(event: KeyboardEvent<HTMLElement>) {
    const delta = event.key === 'ArrowLeft' ? KEYBOARD_STEP : event.key === 'ArrowRight' ? -KEYBOARD_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    const next = clamp(width + delta);
    setWidth(next);
    writeWidth(next);
  }

  return { width, startResize, resizeByKey };
}
