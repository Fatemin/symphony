import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bus } from '../../observability/bus';
import { listEvents, type EventWithCursor } from '../../repo/events';

export const streamRoutes = new Hono();

/**
 * Server-Sent Events for one issue's activity. On connect it replays everything after `?since=`
 * (cursor), then streams live events from the in-process bus. A 15s heartbeat keeps the
 * connection (and proxies) alive. Each SSE message carries the event kind and JSON payload.
 */
streamRoutes.get('/issues/:id', (c) => {
  const issueId = c.req.param('id');
  const since = Number(c.req.query('since') ?? 0);

  return streamSSE(c, async (stream) => {
    let lastCursor = since;
    // No `event:` field so the browser EventSource fires `onmessage` for every event;
    // the kind is carried inside the JSON payload instead.
    const send = async (e: EventWithCursor) => {
      await stream.writeSSE({ id: String(e.cursor), data: JSON.stringify(e) });
      lastCursor = e.cursor;
    };

    // Replay anything missed before subscribing live.
    for (const e of listEvents({ issue_id: issueId, sinceCursor: since })) await send(e);

    const queue: EventWithCursor[] = [];
    let wake: (() => void) | null = null;
    const unsub = bus.subscribe((e) => {
      if (e.issue_id === issueId && e.cursor > lastCursor) {
        queue.push(e);
        wake?.();
      }
    });

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      unsub();
      wake?.();
    });

    try {
      while (!aborted) {
        if (queue.length === 0) {
          await Promise.race([
            new Promise<void>((r) => (wake = r)),
            new Promise<void>((r) => setTimeout(r, 15_000)),
          ]);
          wake = null;
        }
        if (aborted) break;
        if (queue.length === 0) {
          await stream.writeSSE({ event: 'ping', data: '' });
          continue;
        }
        for (const e of queue.splice(0)) await send(e);
      }
    } finally {
      unsub();
    }
  });
});
