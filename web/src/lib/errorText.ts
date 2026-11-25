import { ApiError } from '@/api/http';

/** `ApiError` 的 message 带「X失败：」动作名和「（HTTP 500）」尾注，给排查看；界面一句话只要原因。 */
const HTTP_SUFFIX = /\s*（HTTP \d{3}）\s*$/;
const ERROR_PREFIX = /^(?:Api)?Error:\s*/;

/** 异常 → 一句给人看的中文原因（规格 2.2）。
 *
 * - `ApiError`：取服务端给的 `reason`，有 `recovery` 就接在后面；没有 reason 时退回 message 并去掉 HTTP 码。
 * - 其他 Error：取 message。
 * - 一律不带 `ApiError:` / `Error:` 前缀与「（HTTP 4xx）」尾注。
 */
export function errorText(error: unknown, fallback = '操作没有完成，请重试'): string {
  if (error instanceof ApiError) {
    const reason = clean(error.reason ?? error.message);
    if (!reason) return fallback;
    const recovery = clean(error.recovery ?? '');
    return recovery && !reason.includes(recovery) ? `${withStop(reason)}${recovery}` : reason;
  }
  if (error instanceof Error) return clean(error.message) || fallback;
  if (typeof error === 'string') return clean(error) || fallback;
  return fallback;
}

function clean(text: string): string {
  return text.replace(ERROR_PREFIX, '').replace(HTTP_SUFFIX, '').trim();
}

/** 原因与修复建议之间补一个句号，已有句末标点就不补。 */
function withStop(text: string): string {
  return /[。！？.!?]$/.test(text) ? text : `${text}。`;
}
