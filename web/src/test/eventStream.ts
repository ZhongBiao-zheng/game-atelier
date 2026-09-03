/** 一个可被多个订阅者同时读取的测试事件源：每次 open() 发一份新 Response，emit 广播到全部。 */
export function createTestEventStream() {
  const writers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const open = () => new Response(new ReadableStream<Uint8Array>({ start(output) { writers.push(output); } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  return {
    open,
    response: open(),
    emit(event: string, data: unknown) {
      const frame = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      writers.forEach(writer => writer.enqueue(frame));
    },
  };
}
