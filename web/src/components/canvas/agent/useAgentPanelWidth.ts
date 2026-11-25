import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

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

/** 面板的 style.width：窄窗口下不超出视口。面板渲染与拖动中直接写样式共用这一个写法。 */
export function agentPanelWidthStyle(width: number): string {
  return `min(${width}px, calc(100vw - 2rem))`;
}

export function useAgentPanelWidth() {
  const [width, setWidth] = useState(readWidth);
  const panelRef = useRef<HTMLElement>(null);

  /** 面板贴右边，往左拖变宽。拖动中每帧最多一次直接写面板的 style.width（不经过 React，面板与整条对话不重渲染），
   *  松手才 setState 并记住；提交用拖动过程里的最后一个值，不读可能过期的 state。 */
  function startResize(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    let frame = 0;
    handle.setPointerCapture(event.pointerId);
    const paint = () => {
      frame = 0;
      const panel = panelRef.current;
      if (!panel) return;
      panel.style.width = agentPanelWidthStyle(latest);
      handle.setAttribute('aria-valuenow', String(latest));
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      latest = clamp(startWidth + startX - moveEvent.clientX);
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (frame) window.cancelAnimationFrame(frame);
      paint();
      setWidth(latest);
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

  return { width, panelRef, startResize, resizeByKey };
}
