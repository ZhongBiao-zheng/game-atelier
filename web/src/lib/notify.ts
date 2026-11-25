import { toast } from '@/components/ui/sonner';

/** 全站反馈件的唯一入口（规格 2.2）：页面不直接调 sonner 的 toast。
 *
 * - 成功默认不发 toast，原位换勾（DESIGN.md「成功与失败」）；只有没有原位锚点的后台完成才用 `info`。
 * - toast 里不放上游原文：`message` 是一句中文原因（用 `errorText(e)` 取），原文留给卡片 / 表单的「查看技术详情」。
 * - 悬停暂停计时由 sonner 自带；动作按钮在右侧。
 */

export interface NotifyAction {
  label: string;
  onClick: () => void;
}

/** 撤销窗口：8 秒，悬停时暂停。 */
export const UNDO_DURATION_MS = 8000;
/** toast 里嵌用户起的名字（项目名、对话名）时超过这个长度截断。 */
export const NOTIFY_NAME_MAX = 12;

/** 名称超 12 字截断，用在「已移至回收站：项目「…」」这类文案里。 */
export function clipName(name: string, max = NOTIFY_NAME_MAX): string {
  const chars = Array.from(name.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function error(message: string, options: { action?: NotifyAction; detail?: string } = {}): string | number {
  return toast.error(message, {
    // 一句补充说明（如「请到供应商官网充值」），不是原文。
    description: options.detail,
    action: options.action,
  });
}

function undo(message: string, onUndo: () => void, options: { actionLabel?: string } = {}): string | number {
  return toast(message, {
    duration: UNDO_DURATION_MS,
    action: { label: options.actionLabel ?? '撤销', onClick: onUndo },
  });
}

function info(message: string): string | number {
  return toast(message);
}

function dismiss(id?: string | number): void {
  toast.dismiss(id);
}

export const notify = { error, undo, info, dismiss };
