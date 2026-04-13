/**
 * SSE Stream Handler
 * Wraps a TransformStream to emit Server-Sent Events for the SMTP conversation.
 */
export class StreamHandler {
  constructor() {
    const { readable, writable } = new TransformStream();
    this.readable = readable;
    this.writer = writable.getWriter();
    this.encoder = new TextEncoder();
    this.events = [];
  }

  /**
   * Emit an SSE event to the stream.
   * @param {"sent"|"received"|"info"|"error"|"tls"|"complete"} type
   * @param {string} data
   */
  async emit(type, data) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      data: data.replace(/\r?\n$/, ''),
    };
    this.events.push(event);

    const line = `data: ${JSON.stringify(event)}\n\n`;
    try {
      await this.writer.write(this.encoder.encode(line));
    } catch (e) {
      // Client disconnected, ignore
    }
  }

  /**
   * Close the SSE stream.
   */
  async close() {
    try {
      await this.writer.close();
    } catch (e) {
      // Already closed
    }
  }

  /**
   * Get SSE response headers.
   */
  static responseHeaders() {
    return {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'Pragma': 'no-cache',
      'Expires': '0',
    };
  }
}
