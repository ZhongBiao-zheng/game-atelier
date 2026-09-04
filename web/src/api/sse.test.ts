import { describe, expect, it } from 'vitest';
import { readServerEvents, type ServerEvent } from './sse';

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(output) { chunks.forEach(chunk => output.enqueue(new TextEncoder().encode(chunk))); output.close(); } });
}
describe('authenticated SSE framing', () => {
  it('handles split CRLF lines, heartbeats, multiline data and multiple events per chunk', async () => {
    const received: ServerEvent[] = [];
    await readServerEvents(stream([': keepalive\r', '\n\r\nevent: job-cha', 'nged\r\ndata: {"job_id":\r\ndata: "j1"}\r\n\r', '\nevent: projects-changed\ndata: {}\n\n']), event => received.push(event), new AbortController().signal);
    expect(received).toEqual([{ event: 'job-changed', data: '{"job_id":\n"j1"}' }, { event: 'projects-changed', data: '{}' }]);
  });
  it('rejects oversized lines and oversized multiline frames', async () => {
    await expect(readServerEvents(stream(['data: ' + 'x'.repeat(65537)]), () => {}, new AbortController().signal)).rejects.toThrow('事件消息过大');
    await expect(readServerEvents(stream(Array.from({ length: 100 }, () => 'data: ' + 'x'.repeat(1024) + '\n')), () => {}, new AbortController().signal)).rejects.toThrow('事件消息过大');
  });
  it('cancels a waiting reader on abort and never emits an incomplete event', async () => {
    const abort = new AbortController(); let cancelled = false; const received: ServerEvent[] = [];
    const source = new ReadableStream<Uint8Array>({ start(output) { output.enqueue(new TextEncoder().encode('data: unfinished')); }, cancel() { cancelled = true; } });
    const pending = readServerEvents(source, event => received.push(event), abort.signal);
    abort.abort(); await pending;
    expect(cancelled).toBe(true); expect(received).toEqual([]);
  });
});
