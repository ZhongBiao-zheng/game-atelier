export function createTestEventStream() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(output) { writer = output; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  return {
    response,
    emit(event: string, data: unknown) {
      writer.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
  };
}
