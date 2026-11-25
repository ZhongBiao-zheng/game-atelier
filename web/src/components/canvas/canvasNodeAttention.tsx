import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  animate,
  clearOnFinish,
  MOTION_DURATION,
  MOTION_EASE,
  motionAvailable,
  prefersReducedMotion,
} from '@/lib/motion';

/** 画布上「看这里」的提示：新建节点的入场、撤销重做与 Agent 改动后的主题色描边、新连线闪一次。
 *  记在模块里而不是 context：只有被点名的节点 / 连线读得到，其余节点不跟着重渲染。
 *  只动节点内层 .canvas-node-shell，不碰 xyflow 外层的定位 transform。 */

/** 点名之后多久内挂上的才播：屏外节点（onlyRenderVisibleElements 没渲染）之后平移过去不补播。 */
const ATTENTION_WINDOW_MS = 400;

const entrances = new Map<string, { scale: number; at: number }>();

/** 新建节点：外壳挂载时从 scale 淡入放大到 1（200ms）。scale = 1 只淡入（媒体处理结果接替占位卡）。 */
export function markCanvasNodesEntering(ids: Iterable<string>, scale = 0.98) {
  const at = Date.now();
  for (const id of ids) entrances.set(id, { scale, at });
}

/** 节点外壳挂载时调一次；没被点名、或点名已过期就什么都不做。减弱动态效果时只淡入。 */
export function playCanvasNodeEntrance(id: string, shell: HTMLElement) {
  const entrance = entrances.get(id);
  if (!entrance) return;
  entrances.delete(id);
  if (Date.now() - entrance.at > ATTENTION_WINDOW_MS || !motionAvailable()) return;
  const reduced = prefersReducedMotion();
  const keyframes = reduced || entrance.scale === 1
    ? { opacity: [0, 1] }
    : { opacity: [0, 1], scale: [entrance.scale, 1] };
  clearOnFinish(
    animate(shell, keyframes, { duration: reduced ? MOTION_DURATION.fast : MOTION_DURATION.base, ease: MOTION_EASE.out }),
    shell,
  );
}

type Listener = () => void;

/** 一组「闪一次」的标记：id → 序号。序号变了就重播；过了窗口自动摘掉，平移回视口不再闪。 */
function createFlashStore() {
  let flashes: ReadonlyMap<string, number> = new Map();
  let sequence = 0;
  const listeners = new Set<Listener>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    flash(ids: Iterable<string>) {
      const next = new Map(flashes);
      const marked = new Map<string, number>();
      for (const id of ids) {
        sequence += 1;
        next.set(id, sequence);
        marked.set(id, sequence);
      }
      if (!marked.size) return;
      flashes = next;
      notify();
      window.setTimeout(() => {
        const pruned = new Map(flashes);
        for (const [id, value] of marked) if (pruned.get(id) === value) pruned.delete(id);
        flashes = pruned;
        notify();
      }, ATTENTION_WINDOW_MS);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get(id: string) {
      return flashes.get(id);
    },
  };
}

const nodeFlashes = createFlashStore();
const edgeFlashes = createFlashStore();

/** 撤销重做、Agent 改过的节点：外框叠一圈主题色描边，300ms 淡出（Q7）。 */
export function flashCanvasNodes(ids: Iterable<string>) {
  nodeFlashes.flash(ids);
}

/** 刚建立的连线：路径用主题色亮一下再淡回（Q15）。 */
export function flashCanvasEdges(ids: Iterable<string>) {
  edgeFlashes.flash(ids);
}

function useCanvasEdgeFlash(id: string): number | undefined {
  return useSyncExternalStore(edgeFlashes.subscribe, () => edgeFlashes.get(id));
}

/** 放在节点外壳里：被点名时画一圈描边，淡出后卸掉。jsdom 不播，也不留着描边。 */
export function CanvasNodeFlash({ nodeId }: { nodeId: string }) {
  const nonce = useSyncExternalStore(nodeFlashes.subscribe, () => nodeFlashes.get(nodeId));
  if (nonce === undefined || !motionAvailable()) return null;
  return <FadingMark key={nonce} className="pointer-events-none absolute -inset-1 z-30 rounded-xl ring-2 ring-primary" />;
}

/** 挂载即从不透明淡到 0，播完自己卸掉。减弱动态效果照样淡（只有透明度），时长压到 150ms。 */
function useFadeOutOnce<T extends Element>() {
  const ref = useRef<T>(null);
  const [done, setDone] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const controls = animate(
      element,
      { opacity: [1, 0] },
      { duration: prefersReducedMotion() ? MOTION_DURATION.fast : MOTION_DURATION.slow, ease: MOTION_EASE.subtle },
    );
    void controls.finished.then(() => setDone(true));
    return () => controls.stop();
  }, []);
  return { ref, done };
}

function FadingMark({ className }: { className: string }) {
  const { ref, done } = useFadeOutOnce<HTMLSpanElement>();
  if (done) return null;
  return <span ref={ref} aria-hidden="true" className={className} />;
}

/** 新连线上叠一条主题色路径，淡出后卸掉。 */
export function CanvasEdgeFlash({ edgeId, path }: { edgeId: string; path: string }) {
  const nonce = useCanvasEdgeFlash(edgeId);
  if (nonce === undefined || !motionAvailable()) return null;
  return <FadingPath key={nonce} path={path} />;
}

function FadingPath({ path }: { path: string }) {
  const { ref, done } = useFadeOutOnce<SVGPathElement>();
  if (done) return null;
  return <path ref={ref} d={path} fill="none" strokeWidth={3} className="pointer-events-none stroke-primary" />;
}
