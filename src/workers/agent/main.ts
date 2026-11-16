// Agent process entrypoint. One OS process = one worker execution, spawned and supervised by src/runtime/agents/supervisor.ts.
//
//   node src/workers/agent/main.ts <agent-spec.json> --execution=<id>
//
// It refuses to run without a supervisor (an IPC channel): a worker is never started by hand, by an IDE session or by a chat
// assistant. It runs the existing runtime-owned coding runner (mutation policy, formatting, sandboxed verification, bounded
// retries) on its own worktree with its own model binding; it proposes, and only the runtime verifier can produce PASS.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../../core/paths.ts';
import { AGENT_SPEC_SCHEMA, type AgentMessage, type AgentSpec } from '../../runtime/agents/supervisor.ts';
import { assertWorktreeOwnedBy } from '../../runtime/project/target-repository.ts';
import { executeDelegation, languageOf, type DelegationRequest } from '../../runtime/execution/delegation.ts';
import type { WorkerLike } from '../../runtime/execution/coding-task-runner.ts';
import { createTraceSink } from '../../runtime/execution/coding-task-trace.ts';
import { knowledgeDbPath, loadActiveCatalog } from '../../runtime/knowledge/engineering-control.ts';
import { bindingMetadata, bindingOf, modelResolverFromEnv } from '../../runtime/models/index.ts';
import { createCodingWorker } from '../coding-worker.ts';
import { createOllamaProvider } from '../providers/ollama.ts';
import { defaultProviderRegistry } from '../providers/default.ts';
import * as executionTools from '../tools/execution-tools.ts';
import * as repositoryTools from '../tools/repository-tools.ts';

const send = (message: AgentMessage): void => {
  try {
    process.send?.(message);
  } catch {
    /* the supervisor is gone; the disconnect handler aborts the run */
  }
};

function fail(code: number, message: string): never {
  console.error(`agent: ${message}`);
  process.exit(code);
}

if (typeof process.send !== 'function') fail(2, 'refusing to run: an agent process must be spawned by the runtime supervisor (no IPC channel)');
const specPath = process.argv[2];
if (!specPath) fail(2, 'usage: main.ts <agent-spec.json> --execution=<id>');
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as AgentSpec;
if (spec.schema !== AGENT_SPEC_SCHEMA) fail(2, `unsupported spec schema ${String(spec.schema)}`);
if (!process.argv.includes(`--execution=${spec.executionId}`)) fail(2, 'the execution id on the command line does not match the spec');

const abort = new AbortController();
// No supervisor, no work: an orphaned worker must never keep editing a worktree that a newer execution may own.
process.on('disconnect', () => abort.abort(new Error('supervisor_lost: the supervising process disconnected')));
process.on('SIGTERM', () => abort.abort(new Error('stopped by the supervisor (SIGTERM)')));
send({ type: 'started', pid: process.pid });
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 5_000);
heartbeat.unref();

/** Wraps every tool the worker can call so the supervisor sees tool execution as it happens (this process is the only user). */
function instrumentTools(): void {
  for (const tool of [...Object.values(repositoryTools), ...Object.values(executionTools)]) {
    const t = tool as { id?: unknown; execute?: (...args: unknown[]) => Promise<unknown> };
    if (!t || typeof t !== 'object' || typeof t.execute !== 'function' || typeof t.id !== 'string') continue;
    const original = t.execute.bind(t);
    const name = t.id;
    t.execute = async (...args: unknown[]) => {
      send({ type: 'tool', phase: 'started', name });
      let ok = false;
      try {
        const out = await original(...args);
        ok = !(out && typeof out === 'object' && (out as { success?: unknown }).success === false);
        return out;
      } finally {
        send({ type: 'tool', phase: 'finished', name, ok });
      }
    };
  }
}

async function buildWorker(request: DelegationRequest): Promise<{ worker: WorkerLike; modelLabel?: string; binding?: ReturnType<typeof bindingOf> }> {
  const language = languageOf(request.contract.allowedFiles);
  if (spec.provider !== 'ollama') {
    // A CLI provider (Codex, Gemini) chooses its own model; it is reported as UNKNOWN unless it says otherwise.
    const entry = defaultProviderRegistry().get(spec.provider);
    if (!language) throw new Error(`provider ${spec.provider}: no language for these files`);
    send({ type: 'model_identity', reported: null });
    return { worker: entry.create({ taskType: language }) };
  }
  const ecosystem = language === 'js' ? 'js' : 'go';
  const agentKey = `coding-worker-${ecosystem}`;
  // The routed model is bound through the resolver: unregistered, unauthorized or incapable models are refused, never swapped.
  const resolver = spec.model ? modelResolverFromEnv().withAssignment(agentKey, spec.model) : modelResolverFromEnv();
  instrumentTools();
  const agent = createCodingWorker(ecosystem, undefined, resolver);
  const binding = bindingOf(agent)!;
  if (spec.model && (binding.providerId !== spec.model.providerId || binding.modelId !== spec.model.modelId)) {
    throw new Error(`model_binding_mismatch: routed ${spec.model.providerId}/${spec.model.modelId}, bound ${binding.providerId}/${binding.modelId}`);
  }
  const base = createOllamaProvider(agent);
  return {
    modelLabel: binding.modelId,
    binding,
    worker: {
      provider: base.provider,
      async generate(prompt, options) {
        const { providerRequest: _providerRequest, ...agentOptions } = options;
        const output = await agent.stream(prompt, agentOptions as never);
        const full = await output.getFullOutput();
        // What the provider says it ran, from its own response; never copied from the assignment.
        const reported = (full as { response?: { modelId?: unknown } }).response?.modelId;
        send({ type: 'model_identity', reported: typeof reported === 'string' && reported ? reported : null });
        return { text: full.text, finishReason: full.finishReason, steps: full.steps as unknown[], usage: (full.totalUsage ?? full.usage) as { inputTokens?: number; outputTokens?: number } };
      },
    },
  };
}

async function main(): Promise<void> {
  if (spec.target) assertWorktreeOwnedBy(spec.target, spec.worktree); // never touch a worktree that is not the target's
  const request = spec.request as unknown as DelegationRequest;
  const { worker, modelLabel, binding } = await buildWorker(request);
  const trace = createTraceSink({ jsonlPath: join(spec.artifactDir, 'trace.jsonl'), onEvent: (event) => send({ type: 'trace', event: { type: event.type, data: event.data, ts: event.ts } }) });
  if (binding) trace.emit('model_bound', bindingMetadata(binding)); // recorded before the first model call, as in-process
  const root = findProjectRoot(import.meta.dirname);
  const result = await executeDelegation(request, {
    repoRoot: spec.worktree,
    worker,
    artifactDir: spec.artifactDir,
    trace,
    knowledgeCatalog: request.contract.knowledge && root ? loadActiveCatalog(knowledgeDbPath(join(root, '.workdir'))) : undefined,
    modelLabel,
    runOptions: { modelTimeoutMs: spec.modelTimeoutMs, signal: abort.signal, runId: spec.runId ?? spec.executionId },
  });
  writeFileSync(join(spec.artifactDir, 'agent-result.json'), JSON.stringify({ ...result, executionId: spec.executionId, agentId: spec.agentId }));
  send({ type: 'result', result: { status: result.status } });
  clearInterval(heartbeat);
  process.exitCode = abort.signal.aborted ? 3 : 0;
  process.disconnect?.();
}

main().catch((err) => {
  console.error(`agent: ${(err as Error).stack ?? (err as Error).message}`);
  process.exitCode = 1;
  process.disconnect?.();
});
