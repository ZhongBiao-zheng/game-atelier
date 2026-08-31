export interface ServerEvent { event: string; data: string }

/** Frames can span network chunks; both a line and the assembled event are bounded. */
export async function readServerEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ServerEvent) => void,
  signal: AbortSignal,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const limit = 64 * 1024;
  let pending = '';
  let name = 'message';
  let data: string[] = [];
  let frameSize = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  function line(value: string) {
    frameSize += value.length;
    if (frameSize > limit) throw new Error('事件消息过大。');
    if (value === '') {
      if (data.length && !signal.aborted) onEvent({ event: name, data: data.join('\n') });
      name = 'message'; data = []; frameSize = 0;
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') name = content;
    if (field === 'data') data.push(content);
  }
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let index = 0;
      while (index < pending.length) {
        const end = pending.slice(index).search(/[\r\n]/);
        if (end < 0) break;
        const at = index + end;
        if (pending[at] === '\r' && at === pending.length - 1) break;
        line(pending.slice(index, at));
        index = at + (pending[at] === '\r' && pending[at + 1] === '\n' ? 2 : 1);
      }
      pending = pending.slice(index);
      if (pending.length + frameSize > limit) throw new Error('事件消息过大。');
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
