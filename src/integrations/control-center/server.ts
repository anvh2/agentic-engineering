import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createControlCenterApp } from './http-app.ts';
import type { Reader } from './adapter.ts';

export function createGateway(options: { reader: Reader; assetsDir: string; pollMs?: number }) {
  const app = createControlCenterApp(options);
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port?: number } | null)?.port;
    if (![ `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}` ].includes(req.headers.host ?? '')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"Local host required"}');
      return;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const response = app.fetch(new Request(`http://${req.headers.host}${req.url ?? '/'}`, { method: req.method, headers, signal: abort.signal }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.on('close', () => app.closeStreams());
  return { server, closeStreams: () => app.closeStreams() };
}
