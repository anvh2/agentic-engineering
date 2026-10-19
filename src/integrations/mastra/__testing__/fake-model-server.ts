/**
 * Test-only: a loopback OpenAI-compatible chat endpoint that records exactly what an agent sent (path, key, model id, tool
 * names, system prompt, user text) and answers with fixed text. It lets a test prove that the resolved model configuration
 * reaches the wire, with no provider, no network beyond 127.0.0.1 and no cost.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  path: string;
  authorization: string | undefined;
  model: string | undefined;
  tools: string[];
  system: string;
  user: string;
  stream: boolean;
}

const text = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

export async function fakeModelServer(reply = 'ok'): Promise<{ url: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { model?: string; stream?: boolean; messages?: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] };
      const messages = body.messages ?? [];
      seen.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        model: body.model,
        tools: (body.tools ?? []).map((t) => t.function?.name ?? '').sort(),
        system: text(messages.find((m) => m.role === 'system')?.content),
        user: messages.filter((m) => m.role === 'user').map((m) => text(m.content)).join('\n'),
        stream: Boolean(body.stream),
      });
      const base = { id: 'chatcmpl-test', created: 0, model: body.model };
      const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
