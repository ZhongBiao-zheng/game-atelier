/** 请求失败 → 一句能定位问题的中文报错。
 *
 * 为什么收在一处：`throw new Error(\`upload failed: 413\`)` 这种原样冒到界面上，画师看到的是
 * 「参考图上传失败：upload failed: 413」—— 既不知道是哪一步、也不知道到底哪里不合规
 * （2026-08-20 同事实测：传了一张 10MB 以上的大图，只看到 413）。所有 api 模块统一走这里：
 *   什么操作失败（what） + 服务端说的具体原因（detail） + 状态码尾注（排查用）
 *
 * detail 由服务端给中文（见 viewer_server/routes.py）；这里只负责取出来、拼好、兜底。
 */

/** 服务端没给 detail 时按状态码兜底 —— 至少说清是「哪一类」问题。 */
function statusReason(status: number, statusText: string): string {
  if (status === 0) return '请求没有发出去（连接被中断）';
  if (status === 404) return '服务端找不到这个接口或资源（可能是版本不匹配，试试重启服务）';
  if (status === 405) return '接口不接受这种请求方法（版本不匹配）';
  if (status === 409) return '和服务端当前状态冲突（可能已被别处改动，刷新后重试）';
  if (status === 413) return '文件超出服务端允许的大小';
  if (status === 422) return '提交的内容不合接口要求';
  if (status === 429) return '请求太频繁，被限流了';
  if (status >= 500) return '服务端内部出错（详情看 viewer-server 终端的日志）';
  if (status >= 400) return statusText || '请求被服务端拒绝';
  return statusText || '未知错误';
}

/** FastAPI 的 detail 形态：字符串、稳定错误对象，或 422 校验的 [{loc,msg}]。 */
function readDetail(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (!body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail.trim() || null;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string') return message.trim() || null;
  }
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const { loc, msg } = item as { loc?: unknown; msg?: unknown };
        const where = Array.isArray(loc) ? loc.join('.') : undefined;
        return [where, typeof msg === 'string' ? msg : null].filter(Boolean).join(' ');
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('；') : null;
  }
  return null;
}

/** 报错里嵌用户输入（名字 / 文件名）时先剪短：一条 200 字的错误挂在窄侧栏里没人读得下去。 */
export function clip(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 失败响应 → 中文 Error。`what` 是动作名（「上传参考图」「创建出图任务」），不带「失败」。 */
export async function apiError(resp: Response, what: string): Promise<Error> {
  let reason: string | null = null;
  try {
    const text = await resp.text();
    try {
      reason = readDetail(JSON.parse(text));
    } catch {
      reason = text.trim().slice(0, 300) || null;
    }
  } catch {
    reason = null;
  }
  return new Error(
    `${what}失败：${reason ?? statusReason(resp.status, resp.statusText)}（HTTP ${resp.status}）`,
  );
}

/** fetch 本身 reject（服务没起 / 端口被占 / 请求被掐断）→ 中文 Error。 */
export function requestError(err: unknown, what: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(
    `${what}失败：连不上本地服务（viewer-server 没在运行，或它的端口被别的程序占了）。` +
      `请重启服务后重试。原始报错：${raw}`,
  );
}

/** `fetch` + 失败即抛中文 Error 的薄封装。GET/POST 都用它，省掉每处两段 if。 */
export async function request(input: string, what: string, init?: RequestInit): Promise<Response> {
  let resp: Response;
  try {
    // init 缺省时不传第二个参数：GET 调用保持单参形态（测试里的 fetch spy 按参数断言）。
    resp = init ? await fetch(input, init) : await fetch(input);
  } catch (e) {
    throw requestError(e, what);
  }
  if (!resp.ok) throw await apiError(resp, what);
  return resp;
}

/** request + JSON 解析（响应体不是 JSON 时也给中文报错，而不是抛 SyntaxError）。 */
export async function requestJson<T>(input: string, what: string, init?: RequestInit): Promise<T> {
  const resp = await request(input, what, init);
  try {
    return (await resp.json()) as T;
  } catch {
    throw new Error(`${what}失败：服务端返回的不是合法 JSON（HTTP ${resp.status}）`);
  }
}
