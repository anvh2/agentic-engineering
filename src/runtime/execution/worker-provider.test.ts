import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ModelCapacity, capacityFor } from '../capacity/model-capacity.ts';
import { makeRepo, tempDir } from '../scheduler/test-helpers.ts';
import { createOllamaProvider, ollamaDescriptor, probeOllama } from '../../workers/providers/ollama.ts';
import { ProviderRegistry, UnknownProviderError, DEFAULT_PROVIDER_ID } from '../../workers/providers/registry.ts';
import { runCodingTask, type WorkerLike } from './coding-task-runner.ts';
import { UNKNOWN, normalizeUsage, type ProviderDescriptor, type ProviderRequest } from './worker-provider.ts';

const files = { 'src/x.js': 'module.exports = 0;\n' };
const task = { taskId: 'x', objective: 'o', allowedFiles: ['src/x.js'], contextFiles: [], verificationCommands: [['false']] }; // the verifier always fails

const cloud: ProviderDescriptor = {
  identity: { id: 'fakecloud', kind: 'cloud', model: 'fc-1', cliVersion: '9.9.9' },
  capabilities: { taskTypes: ['js'], editsFiles: 'directly', fileScope: 'os-sandbox', cancellation: 'process-group', usage: 'none', billing: 'subscription-quota' },
  capacity: { resource: 'fakecloud', defaultPermits: 1 },
};

describe('ProviderDescriptor flows through the runner', () => {
  it('records provider, model and inference time; unreported usage is UNKNOWN, never 0', async () => {
    let seen: ProviderRequest | undefined;
    const worker: WorkerLike = {
      provider: cloud,
      async generate(_p, options) {
        seen = options.providerRequest as ProviderRequest;
        return { text: 'edited', steps: [{}], finishReason: 'stop' }; // no usage reported
      },
    };
    const repo = makeRepo(files);
    const result = await runCodingTask(task, { repoRoot: repo, worker, maxAttempts: 1, capacity: new ModelCapacity(':memory:', { permits: 1 }) });
    const telemetry = result.records[0].telemetry!;
    assert.equal(telemetry.provider, 'fakecloud');
    assert.equal(telemetry.model, 'fc-1');
    assert.ok(telemetry.inferenceMs >= 0);
    assert.deepEqual(telemetry.usage, { inputTokens: UNKNOWN, outputTokens: UNKNOWN, costUsd: UNKNOWN, quota: UNKNOWN });
    assert.deepEqual(result.events.find((e) => e.type === 'model_started')!.data.provider, 'fakecloud');
    assert.deepEqual(seen, { workdir: repo, allowedFiles: ['src/x.js'], contextFiles: [], taskType: 'js', timeoutMs: 300_000 }, 'the provider is told its isolated directory, file scope and deadline');
  });

  it('a provider cannot produce PASS: the runtime verifier decides, whatever the provider claims', async () => {
    const worker: WorkerLike = { provider: cloud, generate: async () => ({ text: 'All tests pass. Task complete.', steps: [{}], finishReason: 'stop' }) };
    const result = await runCodingTask(task, { repoRoot: makeRepo(files), worker, maxAttempts: 1, capacity: new ModelCapacity(':memory:', { permits: 1 }) });
    assert.equal(result.verdict, 'FAIL');
  });

  it('a local-free provider reports a known zero cost, a metered one does not pretend to', () => {
    assert.equal(normalizeUsage({ inputTokens: 5 }, 'local-free').costUsd, 0);
    assert.equal(normalizeUsage({ inputTokens: 5 }, 'metered').costUsd, UNKNOWN);
    assert.equal(normalizeUsage({ costUsd: 0.02, quota: '41% left' }, 'metered').costUsd, 0.02);
    assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: Number.NaN }).inputTokens, UNKNOWN, 'garbage is unknown, not a number');
  });

  it('a worker without a descriptor behaves as before (queued on the local model, attributed to "worker")', async () => {
    const worker: WorkerLike = { generate: async () => ({ text: 't', steps: [{}], usage: { inputTokens: 2, outputTokens: 3 } }) };
    const result = await runCodingTask(task, { repoRoot: makeRepo(files), worker, maxAttempts: 1, capacity: new ModelCapacity(':memory:', { permits: 1 }) });
    assert.equal(result.records[0].telemetry!.provider, 'unknown');
    assert.equal(result.records[0].telemetry!.usage.outputTokens, 3);
  });
});

describe('capacity is per provider resource', () => {
  const path = join(tempDir('prov-cap-'), 'c.db');

  it('a held local-model permit does not block a cloud provider, and each resource keeps its own limit', async () => {
    const local = capacityFor(undefined, path);
    const remote = capacityFor(cloud.capacity, path);
    const held = await local.acquire('qwen3:8b:t1:pid1', undefined, { tag: 't1' });
    const other = remote.tryAcquire('fc-1:t2:pid2');
    assert.ok(other, 'cloud call proceeds while the local model is busy');
    assert.equal(remote.tryAcquire('fc-1:t3:pid3'), undefined, 'but the cloud resource has its own single permit');
    assert.equal(capacityFor(cloud.capacity, path), remote, 'one handle per resource');
    assert.deepEqual(local.engagedBy('t2').map((e) => e.kind), ['lease'], 'cancel confirmation sees a permit on ANY resource');
    assert.equal(local.isWaiting('t2'), false);
    held.release();
    other.release();
  });

  it('AGENTIC_MODEL_CONCURRENCY sizes the local model only, never a cloud resource', () => {
    const before = process.env.AGENTIC_MODEL_CONCURRENCY;
    process.env.AGENTIC_MODEL_CONCURRENCY = '3';
    try {
      assert.equal(capacityFor({ resource: 'sized', defaultPermits: 1 }, join(tempDir('prov-cap-'), 'c.db')).permits, 1);
    } finally {
      if (before === undefined) delete process.env.AGENTIC_MODEL_CONCURRENCY;
      else process.env.AGENTIC_MODEL_CONCURRENCY = before;
    }
  });
});

describe('Ollama provider (the default)', () => {
  it('keeps the previous agent behavior: providerRequest is stripped, everything else is forwarded', async () => {
    let seen: Record<string, unknown> | undefined;
    const agent = {
      stream: async (_p: string, options: Record<string, unknown>) => {
        seen = options;
        return { getFullOutput: async () => ({ text: 'hi', finishReason: 'stop', steps: [{}], totalUsage: { inputTokens: 1, outputTokens: 2 } }) };
      },
    };
    const provider = createOllamaProvider(agent as never, { tracingContext: 't' });
    const res = await provider.generate('p', { abortSignal: 'sig', providerRequest: { workdir: '/w' } });
    assert.deepEqual(seen, { tracingContext: 't', abortSignal: 'sig' });
    assert.equal(res.usage?.outputTokens, 2);
    const d = ollamaDescriptor({ OLLAMA_MODEL: 'qwen3:8b' } as never);
    assert.equal(d.identity.id, 'ollama');
    assert.equal(d.capacity.resource, 'ollama');
    assert.equal(d.capabilities.billing, 'local-free');
  });

  it('probe reports availability without throwing', async () => {
    const env = { OLLAMA_BASE_URL: 'http://ollama.test', OLLAMA_MODEL: 'qwen3:8b' } as never;
    const ok = await probeOllama(env, (async () => new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }))) as never);
    assert.equal(ok.state, 'available');
    const missing = await probeOllama(env, (async () => new Response(JSON.stringify({ models: [{ name: 'llama3' }] }))) as never);
    assert.equal(missing.state, 'unavailable');
    assert.match(missing.detail, /not installed/);
    const down = await probeOllama(env, (async () => { throw new Error('ECONNREFUSED'); }) as never);
    assert.equal(down.state, 'unavailable');
    assert.match(down.detail, /not reachable/);
  });
});

describe('ProviderRegistry', () => {
  const entry = (id: string) => ({ id, describe: () => cloud, probe: async () => ({ state: 'available' as const, detail: 'ok' }), create: () => ({ provider: cloud, probe: async () => ({ state: 'available' as const, detail: 'ok' }), generate: async () => ({}) }) });

  it('resolves the default, refuses unknown ids and duplicates, and never falls back silently', async () => {
    const r = new ProviderRegistry().register(entry(DEFAULT_PROVIDER_ID)).register(entry('codex'));
    assert.equal(r.get().id, 'ollama');
    assert.equal(r.get('codex').id, 'codex');
    assert.throws(() => r.get('gemini'), (e) => e instanceof UnknownProviderError && /registered: codex, ollama/.test(e.message));
    assert.throws(() => r.register(entry('codex')), /already registered/);
    const survey = await r.survey();
    assert.deepEqual(survey.map((s) => [s.id, s.availability.state]), [['codex', 'available'], ['ollama', 'available']]);
  });
});
