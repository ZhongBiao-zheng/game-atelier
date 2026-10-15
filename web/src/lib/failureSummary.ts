const RAW_MARKER = '（原始报错：';

function jsonMessage(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const body = JSON.parse(text.slice(start)) as { message?: unknown; error?: { message?: unknown } | string };
    const message = typeof body.error === 'object' ? body.error?.message : body.message ?? body.error;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

/** 失败原因的一句话摘要；与原文相同时界面不提供展开。 */
export function failureSummary(reason: string): string {
  const marker = reason.indexOf(RAW_MARKER);
  if (marker > 0) return reason.slice(0, marker).trim();
  const message = jsonMessage(reason);
  if (!message) return reason;
  return message.replace(/\s*\(request id:[^)]*\)\s*$/i, '').trim() || reason;
}
