import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../../runtime/execution/coding-task-trace.ts';
import type { Reader } from './adapter.ts';

/** Shared read-only transport. No runtime, scheduler or provider is constructed here. */
export function createControlCenterApp(options: {
  reader: Reader; assetsDir: string; pollMs?: number; embedded?: boolean;
}) {
  const clients = new Set<() => void>();
  const wire = (value: unknown) => redact(JSON.stringify(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const api = options.embedded ? '/control-center/v1' : '/api/v1';
  const assets = options.embedded ? '/organization-app/' : '/';
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors ${options.embedded ? "'self'" : "'none'"}; form-action 'none'`,
  };
  const json = (status: number, value: unknown) => new Response(wire(value), { status, headers: { ...headers, 'Content-Type': 'application/json', ...(status === 405 ? { Allow: 'GET' } : {}) } });
  return {
    closeStreams() { for (const close of clients) close(); },
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return json(403, { error: 'Local host required' });
      if ((request.headers.has('origin') && request.headers.get('origin') !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return json(403, { error: 'Same origin required' });
      if (request.method !== 'GET') return json(405, { error: 'Read-only Gateway' });
      const objectiveId = url.searchParams.get('objectiveId');
      if (objectiveId !== null && !/^[A-Za-z0-9._-]{1,200}$/.test(objectiveId)) return json(400, { error: 'Invalid objectiveId' });
      if (url.pathname === `${api}/collaboration`) return json(200, {
        availability: 'NOT_AVAILABLE', source: 'unavailable', threads: [], meetings: [],
        reason: 'Core B collaboration read model is not integrated on this branch. No live discussions or meetings are connected.',
      });
      if (url.pathname === `${api}/snapshot`) return json(200, options.reader.snapshot(objectiveId));
      if (url.pathname === `${api}/events`) {
        if (clients.size >= 16) return json(503, { error: 'Too many event streams' });
        let cleanup = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            let timer: ReturnType<typeof setInterval> | undefined;
            const encoder = new TextEncoder();
            cleanup = () => {
              if (closed) return;
              closed = true;
              clearInterval(timer);
              clients.delete(cleanup);
              request.signal.removeEventListener('abort', cleanup);
              controller.close();
            };
            clients.add(cleanup);
            request.signal.addEventListener('abort', cleanup, { once: true });
            const send = (name: string, data: unknown, id?: string) => {
              if (closed) return;
              // Bound queued bytes for slow or disconnected consumers.
              if ((controller.desiredSize ?? 0) <= 0) { cleanup(); return; }
              controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${wire(data)}\n\n`));
            };
            let cursor = request.headers.get('last-event-id') ?? url.searchParams.get('cursor') ?? '';
            const tick = () => {
              try {
                const snapshot = options.reader.snapshot(objectiveId);
                if (snapshot.source === 'disconnected') { send('connection', { state: 'disconnected' }); return; }
                if (cursor && objectiveId) {
                  const replay = options.reader.eventsAfter(objectiveId, cursor);
                  if (replay.reset) send('reset', { reason: 'Cursor unavailable; replace the snapshot' });
                  else for (const event of replay.events) send(event.type, event, event.id);
                  cursor = replay.cursor;
                } else cursor = snapshot.cursor!;
                const current = options.reader.snapshot(objectiveId);
                if (current.source === 'disconnected') { send('connection', { state: 'disconnected' }); return; }
                send('snapshot', current);
                send('checkpoint', { cursor }, cursor);
              } catch { send('connection', { state: 'disconnected' }); }
            };
            controller.enqueue(encoder.encode('retry: 2000\n\n'));
            tick();
            if (!closed) timer = setInterval(tick, options.pollMs ?? 2000);
            if (request.signal.aborted) cleanup();
          },
          cancel() { cleanup(); },
        }, { highWaterMark: 1024 * 1024, size: chunk => chunk.byteLength });
        return new Response(body, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } });
      }
      const file = ({ [assets]: ['index.html', 'text/html; charset=utf-8'], [`${assets}app.js`]: ['app.js', 'text/javascript; charset=utf-8'], [`${assets}app.css`]: ['app.css', 'text/css; charset=utf-8'] } as Record<string, string[]>)[url.pathname];
      if (!file) return json(404, { error: 'Not found' });
      try {
        let content: Uint8Array | string = readFileSync(join(options.assetsDir, file[0]));
        if (options.embedded && file[0] === 'index.html') content = Buffer.from(content).toString().replaceAll('href="/app.css"', 'href="/organization-app/app.css"').replaceAll('src="/app.js"', 'src="/organization-app/app.js"');
        return new Response(content as BodyInit, { headers: { ...headers, 'Content-Type': file[1] } });
      } catch { return json(503, { error: 'UI not built. Run npm run build in apps/control-center.' }); }
    },
  };
}
