import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../../runtime/execution/coding-task-trace.ts';
import { type Reader } from './adapter.ts';

export function createGateway(options: { reader: Reader; assetsDir: string; pollMs?: number }) {
  const clients = new Set<ServerResponse>();
  const wire = (data: unknown) =>
    redact(JSON.stringify(data))
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(wire(body));
    };
    const port = (server.address() as { port?: number } | null)?.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!req.headers.host || !hosts.has(req.headers.host)) return json(403, { error: 'Local host required' });
    if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site')
      return json(403, { error: 'Same origin required' });
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(405, { error: 'Read-only Gateway' });
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    } catch {
      return json(400, { error: 'Invalid URL' });
    }
    const objectiveId = url.searchParams.get('objectiveId');
    if (objectiveId !== null && !/^[A-Za-z0-9._-]{1,200}$/.test(objectiveId)) return json(400, { error: 'Invalid objectiveId' });
    if (url.pathname === '/api/v1/snapshot') return json(200, options.reader.snapshot(objectiveId));
    if (url.pathname === '/api/v1/events') {
      if (clients.size >= 16) return json(503, { error: 'Too many event streams' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      clients.add(res);
      res.write('retry: 2000\n\n');
      let cursor = String(req.headers['last-event-id'] ?? url.searchParams.get('cursor') ?? '');
      const send = (name: string, data: unknown, id?: string) => {
        if (!res.write(`${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${wire(data)}\n\n`)) res.destroy(); // bounded memory for slow consumers
      };
      const tick = () => {
        try {
          const snapshot = options.reader.snapshot(objectiveId);
          if (snapshot.source === 'disconnected') {
            send('connection', { state: 'disconnected' });
            return;
          }
          if (cursor && objectiveId) {
            const replay = options.reader.eventsAfter(objectiveId, cursor);
            if (replay.reset) send('reset', { reason: 'Cursor unavailable; replace the snapshot' });
            else for (const event of replay.events) send(event.type, event, event.id);
            cursor = replay.cursor;
          } else cursor = snapshot.cursor!;
          // Refetch after replay so the replacement includes every event already delivered.
          const current = options.reader.snapshot(objectiveId);
          if (current.source === 'disconnected') {
            send('connection', { state: 'disconnected' });
            return;
          }
          send('snapshot', current);
          send('checkpoint', { cursor }, cursor);
        } catch {
          send('connection', { state: 'disconnected' });
        }
      };
      tick();
      const timer = setInterval(tick, options.pollMs ?? 2000);
      res.on('close', () => {
        clearInterval(timer);
        clients.delete(res);
      });
      return;
    }
    const file = (
      {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/app.css': ['app.css', 'text/css; charset=utf-8'],
      } as Record<string, [string, string]>
    )[url.pathname];
    if (!file) return json(404, { error: 'Not found' });
    try {
      const content = readFileSync(join(options.assetsDir, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(content);
    } catch {
      json(503, { error: 'UI not built. Run npm run build in apps/control-center.' });
    }
  });
  server.on('close', () => {
    for (const res of clients) res.destroy();
  });
  return {
    server,
    closeStreams: () => {
      for (const res of clients) res.end();
    },
  };
}
