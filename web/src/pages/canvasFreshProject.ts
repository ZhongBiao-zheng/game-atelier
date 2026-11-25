/** 「新建项目」直接建出的「未命名项目」（D12）。
 *
 *  清理空项目的守卫挂在「本会话里点了新建项目」这个动作上，而不是「项目是空的」：
 *  后者会把用户打开的任何空项目都清掉（见 memory auto-create-guard-must-be-the-trigger）。
 *  只在内存里记，刷新页面后不再清理，宁可留一个空项目。 */

export const UNTITLED_CANVAS_PROJECT_NAME = '未命名项目';

const freshProjectIds = new Set<string>();

export function markFreshCanvasProject(projectId: string): void {
  freshProjectIds.add(projectId);
}

export function isFreshCanvasProject(projectId: string): boolean {
  return freshProjectIds.has(projectId);
}

/** 用户在新项目里做了任何编辑或改了名：从此不再自动清理。 */
export function settleFreshCanvasProject(projectId: string): void {
  freshProjectIds.delete(projectId);
}

/** 清掉一个空项目后广播，项目列表据此把它从卡片里拿掉（列表可能在清理落地前就读完了）。 */
export const CANVAS_PROJECT_DISCARDED_EVENT = 'atelier:canvas-project-discarded';

const openEditors = new Map<string, number>();

/** 画布编辑器打开一个项目时登记，返回释放函数。 */
export function openCanvasEditor(projectId: string): () => void {
  openEditors.set(projectId, (openEditors.get(projectId) ?? 0) + 1);
  return () => {
    const count = (openEditors.get(projectId) ?? 1) - 1;
    if (count > 0) openEditors.set(projectId, count);
    else openEditors.delete(projectId);
  };
}

/** 编辑器离开一个新建项目时调用：下一拍仍没有编辑器打开它（排除 StrictMode 的卸载再挂载）、
 *  用户也没做过任何编辑或改名，就请服务端清掉（服务端只在项目确实为空时才删）。 */
export function scheduleFreshCanvasProjectCleanup(
  projectId: string,
  discard: (projectId: string) => Promise<boolean>,
): void {
  window.setTimeout(() => {
    if (!freshProjectIds.has(projectId) || openEditors.has(projectId)) return;
    freshProjectIds.delete(projectId);
    void discard(projectId)
      .then(discarded => {
        if (discarded) {
          window.dispatchEvent(new CustomEvent(CANVAS_PROJECT_DISCARDED_EVENT, { detail: projectId }));
        }
      })
      .catch(() => undefined);
  }, 0);
}
