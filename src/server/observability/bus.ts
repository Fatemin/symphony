import { EventEmitter } from 'node:events';
import type { EventWithCursor } from '../repo/events';

/**
 * In-process pub/sub for live activity events. The orchestrator publishes every persisted event
 * here; SSE connections subscribe. Decouples the scheduler from the transport — the orchestrator
 * never imports HTTP code.
 */
class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0); // many concurrent SSE clients
  }

  publish(event: EventWithCursor): void {
    this.emitter.emit('event', event);
  }

  /** Subscribe to all events; returns an unsubscribe function. */
  subscribe(handler: (event: EventWithCursor) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}

export const bus = new EventBus();
