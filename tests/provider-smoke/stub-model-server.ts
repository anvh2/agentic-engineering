import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for the model API (the OpenAI Responses protocol, as spoken by codex-cli 0.161.0), so the REAL `codex exec` binary can
 * be driven without any cloud call: it makes the model "decide" to run one shell command, then ends the turn. This exercises what a
 * fake CLI cannot: the CLI's real sandbox deciding what a model-issued command may read and write. Nothing here is a model; no
 * request leaves 127.0.0.1.
 */

export interface StubModel {
  port: number;
  /** Extra `codex exec` arguments that point the CLI at this server (test-only; the adapter itself never emits them). */
  codexArgs: string[];
  /** The text each `exec_command` returned to the "model", in order. */
  outputs(): string[];
  /** Every `/responses` request body the CLI sent (the first one lists the tools the model is offered). */
  /** The `authorization` header of each `/responses` request (what the CLI authenticated with). */
  authorizations(): string[];
  requests(): { tools?: { type?: string; name?: string }[]; [k: string]: unknown }[];
  close(): Promise<void>;
}

const sse = (events: { type: string }[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const usage = { input_tokens: 5, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 10 };

export async function startStubModel(command: string, options: { requiresAuth?: boolean; /** Call this tool instead of `exec_command`. */ tool?: { name: string; args: Record<string, unknown> } } = {}): Promise<StubModel> {
  const outputs: string[] = [];
  let polls = 0;
  const auths: string[] = [];
  const requests: StubModel['requests'] extends () => infer R ? R : never = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"models":[]}');
        return;
      }
      let parsed: { input?: { type?: string; output?: unknown }[] } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* not JSON: treated as a request with no tool output */
      }
      requests.push(parsed as never);
      auths.push(String(req.headers.authorization ?? ''));
      const done = (parsed.input ?? []).filter((i) => i.type === 'function_call_output');
      const last = done.length > 0 ? String(typeof done[done.length - 1].output === 'string' ? done[done.length - 1].output : JSON.stringify(done[done.length - 1].output)) : '';
      const running = /session ID (\d+)/.exec(last);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (running && !/Process exited/.test(last) && polls < 20) {
        polls += 1;
        res.end(sse([
          { type: 'response.created', response: { id: `p${polls}` } } as never,
          { type: 'response.output_item.done', item: { type: 'function_call', id: `fp${polls}`, call_id: `call_p${polls}`, name: 'write_stdin', arguments: JSON.stringify({ session_id: Number(running[1]), chars: '', yield_time_ms: 30000 }) } } as never,
          { type: 'response.completed', response: { id: `p${polls}`, usage } } as never,
        ]));
        return;
      }
      if (done.length === 0) {
        res.end(sse([
          { type: 'response.created', response: { id: 'r1' } } as never,
          { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: options.tool?.name ?? 'exec_command', arguments: JSON.stringify(options.tool?.args ?? { cmd: command, yield_time_ms: 30000 }) } } as never,
          { type: 'response.completed', response: { id: 'r1', usage } } as never,
        ]));
      } else {
        outputs.length = 0;
        for (const d of done) outputs.push(typeof d.output === 'string' ? d.output : JSON.stringify(d.output));
        res.end(sse([
          { type: 'response.created', response: { id: 'r2' } } as never,
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }] } } as never,
          { type: 'response.completed', response: { id: 'r2', usage } } as never,
        ]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    codexArgs: ['-c', 'model_provider="stub"', '-c', `model_providers.stub={name="stub",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=${options.requiresAuth ? 'true' : 'false'}}`, '-c', 'model="stub-model"'],
    outputs: () => outputs,
    requests: () => requests,
    authorizations: () => auths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
