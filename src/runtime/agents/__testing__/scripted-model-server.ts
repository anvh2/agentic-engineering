/**
 * Test-only: a loopback OpenAI-compatible endpoint (plus Ollama's /api/tags) that drives a coding agent with SCRIPTED tool
 * calls. Agent processes cannot share an in-process mock model with the test, so this is how the process path is exercised end
 * to end with no provider, no network beyond 127.0.0.1 and no cost. Every answer is labelled with `reportedModel`, so a test can
 * prove that the model identity an agent records came from the response and not from its assignment.
 *
 * This is SCRIPTED evidence, never live-model evidence.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedTurn {
  /** Tool calls to make this turn; the agent loop executes them and calls back. */
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** Final text (ends the agent loop) when no tool calls are given. */
  text?: string;
  /** Delay before answering (to hold an inference in flight). */
  delayMs?: number;
}

export interface ScriptedRequest {
  model: string | undefined;
  user: string;
  /** Tool results already in the conversation (how many turns the agent has completed). */
  toolResults: number;
}

export async function scriptedModelServer(options: { respond: (req: ScriptedRequest) => ScriptedTurn; reportedModel?: string; installed?: { name: string; size: number }[] }) {
  const requests: ScriptedRequest[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: options.installed ?? [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { model?: string; stream?: boolean; messages?: { role: string; content: unknown }[] };
      const messages = body.messages ?? [];
      const r: ScriptedRequest = {
        model: body.model,
        user: messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'),
        toolResults: messages.filter((m) => m.role === 'tool').length,
      };
      requests.push(r);
      const turn = options.respond(r);
      if (turn.delayMs) await new Promise((ok) => setTimeout(ok, turn.delayMs));
      const base = { id: `chatcmpl-${requests.length}`, created: 0, model: options.reportedModel ?? body.model };
      const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
      if (turn.toolCalls?.length) {
        send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: turn.toolCalls.map((c, i) => ({ index: i, id: `call_${requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: null }] });
        send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
      } else {
        send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: turn.text ?? 'done' }, finish_reason: null }] });
        send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
