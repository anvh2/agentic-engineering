import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { findProjectRoot } from '../../core/paths.ts';
import { AgentStore } from './agent-store.ts';
import { AGENT_SPEC_SCHEMA, isAlive, reapStaleAgents, reconcileAgents, spawnAgent, type AgentSpec } from './supervisor.ts';
import { computeAgentMetrics } from './metrics.ts';
import { scriptedModelServer } from './__testing__/scripted-model-server.ts';
import { makeRepo, makeStore, plan, tempDir } from '../scheduler/test-helpers.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import { WorktreeManager } from '../worktree/worktree.ts';
import { resolveTargetRepository } from '../project/target-repository.ts';
import { localMemoryBudgetGb, ollamaInventory, routeWorkerModel } from '../models/routing.ts';
import { modelResolverFromEnv } from '../models/index.ts';
import { createInProcessExecutor } from '../../integrations/mastra/__testing__/in-process-executor.ts';
import { createCodingTaskWorkflow } from '../../integrations/mastra/workflows/coding-task-workflow.ts';

/**
 * Regression tests for the CloudFarm failure that "workers" were Claude Code subagents and logical scheduler slots, never
 * processes the runtime spawned and supervised. Part 1 drives the supervisor with a tiny fixture agent; part 2 runs the real
 * workflow -> agent process -> runner -> sandboxed verifier path against a SCRIPTED loopback model (no live model, no cost).
 */

const fixtureEntry = (body: string): string => {
  const path = join(tempDir('agent-fixture-'), 'agent.mjs');
  writeFileSync(path, `import { readFileSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));\nconst send = (m) => process.send(m);\n${body}\n`);
  return path;
};

const specFor = (taskId: string, extra: Partial<AgentSpec> = {}): AgentSpec => ({
  schema: AGENT_SPEC_SCHEMA, executionId: `agx-${taskId}-${Math.random().toString(16).slice(2, 8)}`, agentId: `coding-worker.${taskId}`, role: 'coding-worker',
  project: 'proj', batchId: 'B1', taskId, claimEpoch: 1, runId: 'run-1', provider: 'ollama', model: { providerId: 'ollama', modelId: 'm:1b' },
  worktree: tempDir('agent-wt-'), target: null, request: {}, allowedTools: ['readFile'], artifactDir: tempDir('agent-art-'), modelTimeoutMs: 1_000, ...extra,
});

describe('agent supervisor: real processes, supervised to the end', () => {
  test('a completed agent records its own pid, permit wait vs inference, tool calls, reported model and exit', async () => {
    const store = new AgentStore(join(tempDir('agents-db-'), 'sched.db'));
    const entry = fixtureEntry(`
send({ type: 'started', pid: process.pid });
send({ type: 'trace', event: { type: 'permit_wait_started', data: { resource: 'ollama' } } });
send({ type: 'trace', event: { type: 'model_started', data: { capacityWaitMs: 40, model: 'm:1b' } } });
send({ type: 'tool', phase: 'started', name: 'readFile' });
send({ type: 'tool', phase: 'finished', name: 'readFile', ok: true });
send({ type: 'model_identity', reported: 'm:1b-reported' });
send({ type: 'trace', event: { type: 'model_finished', data: { durationMs: 120, inputTokens: 5, outputTokens: 3 } } });
writeFileSync(join(spec.artifactDir, 'agent-result.json'), JSON.stringify({ status: 'PASS', pid: process.pid }));
setTimeout(() => process.disconnect(), 50);`);
    const spec = specFor('t1');
    const exit = await spawnAgent(spec, { store, timeoutMs: 20_000, entry });
    assert.equal(exit.status, 'COMPLETED');
    assert.notEqual(exit.pid, process.pid, 'a separate OS process');
    assert.equal((exit.result as { pid: number }).pid, exit.pid);
    const row = store.require(spec.executionId);
    assert.deepEqual([row.status, row.permitWaitMs, row.inferenceMs, row.toolCalls, row.inputTokens, row.outputTokens], ['COMPLETED', 40, 120, 1, 5, 3]);
    assert.equal(row.assignedModel, 'ollama/m:1b');
    assert.equal(row.reportedModel, 'm:1b-reported', 'reported model comes from the agent, not the assignment');
    assert.equal(row.outcome, 'PASS');
    const types = store.events(spec.executionId).map((e) => e.type);
    for (const t of ['spawn_requested', 'spec_written', 'spawned', 'trace.permit_wait_started', 'trace.model_started', 'tool_started', 'tool_finished', 'trace.model_finished', 'exited']) assert.ok(types.includes(t), `${t} in ${types.join(',')}`);
    assert.ok(existsSync(join(spec.artifactDir, 'agent-spec.json')) && existsSync(exit.logPath));
    assert.throws(() => store.db.exec('DELETE FROM agent_events'), /append-only/);
    store.close();
  });

  test('an agent that exits without a result is FAILED, never a verdict', async () => {
    const store = new AgentStore(':memory:');
    const exit = await spawnAgent(specFor('t2'), { store, timeoutMs: 20_000, entry: fixtureEntry(`process.exit(0);`) });
    assert.equal(exit.status, 'FAILED');
    assert.equal(exit.result, null);
    assert.match(exit.failure ?? '', /wrote no result/);
  });

  test('timeout and cancellation stop the whole process group (grandchildren included)', async () => {
    const store = new AgentStore(':memory:');
    const entry = fixtureEntry(`
const { spawn } = await import('node:child_process');
const child = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(join(spec.artifactDir, 'grandchild.pid'), String(child.pid));
send({ type: 'started', pid: process.pid });
setInterval(() => {}, 1000);`);
    const timedSpec = specFor('t3');
    const timed = await spawnAgent(timedSpec, { store, timeoutMs: 1_500, killGraceMs: 500, entry });
    assert.equal(timed.status, 'TIMED_OUT');
    const grandchild = Number(readFileSync(join(timedSpec.artifactDir, 'grandchild.pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isAlive(timed.pid), false);
    assert.equal(isAlive(grandchild), false, 'the agent group was stopped, not just its leader');

    const ctl = new AbortController();
    const cancelSpec = specFor('t4');
    const pending = spawnAgent(cancelSpec, { store, signal: ctl.signal, timeoutMs: 60_000, killGraceMs: 500, entry });
    await new Promise((r) => setTimeout(r, 800));
    ctl.abort(new Error('operator cancel'));
    const cancelled = await pending;
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(store.require(cancelSpec.executionId).failure, 'operator cancel');
  });

  test('a stale execution of the same task is stopped before a new one starts (no duplicate writer)', async () => {
    const store = new AgentStore(join(tempDir('agents-db-'), 'sched.db'));
    const forever = fixtureEntry(`send({ type: 'started', pid: process.pid }); setInterval(() => {}, 1000);`);
    const old = specFor('t5', { claimEpoch: 1 });
    const oldRun = spawnAgent(old, { store, timeoutMs: 60_000, entry: forever });
    await new Promise((r) => setTimeout(r, 800));
    const oldPid = store.require(old.executionId).pid!;
    assert.equal(isAlive(oldPid), true);
    const reaped = await reapStaleAgents(store, 't5', { killGraceMs: 1_000 });
    assert.deepEqual(reaped.superseded, [old.executionId]);
    await oldRun;
    assert.equal(isAlive(oldPid), false);
    assert.equal(store.require(old.executionId).status, 'SUPERSEDED', 'the terminal status written first is kept');
    store.close();
  });

  test('a row whose process and supervisor are gone is reconciled as LOST; the entry refuses to run unsupervised', async () => {
    const store = new AgentStore(':memory:');
    store.create({ executionId: 'agx-ghost', agentId: 'coding-worker.g', role: 'coding-worker', project: 'p', batchId: 'B', taskId: 'g', claimEpoch: 1, runId: null, provider: 'ollama', assignedModel: null, worktree: '/tmp', repositoryId: null, logPath: null, artifactDir: null }, 'gone:999998');
    store.update('agx-ghost', { status: 'RUNNING', pid: 999_999 });
    assert.deepEqual(reconcileAgents(store), ['agx-ghost']);
    assert.equal(store.require('agx-ghost').status, 'LOST');

    const main = join(findProjectRoot(import.meta.dirname)!, 'src', 'workers', 'agent', 'main.ts');
    const r = await new Promise<{ code: number | null; stderr: string }>((ok) => execFile(process.execPath, [main, '/nonexistent.json'], (err, _o, stderr) => ok({ code: (err as { code?: number } | null)?.code ?? 0, stderr })));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /must be spawned by the runtime supervisor/);
  });
});

describe('end to end: scheduler -> workflow -> two independent agent processes (SCRIPTED model)', () => {
  let server: Awaited<ReturnType<typeof scriptedModelServer>>;
  const saved = { ...process.env };
  before(async () => {
    server = await scriptedModelServer({
      reportedModel: 'scripted-coder:1b@server',
      installed: [{ name: 'scripted-coder:1b', size: 1_000_000_000 }],
      respond: (req) => {
        const which = /calc\/(add|sub)\.go/.exec(req.user)?.[1] ?? 'add';
        if (req.toolResults === 0) {
          const body = which === 'add' ? 'func Add(a, b int) int { return a + b }' : 'func Sub(a, b int) int { return a - b }';
          return { toolCalls: [{ name: 'writeFile', args: { path: `calc/${which}.go`, content: `package calc\n\n${body}\n` } }], delayMs: 300 };
        }
        return { text: 'implemented; verified by the runtime' };
      },
    });
    process.env.OLLAMA_BASE_URL = server.baseUrl;
    process.env.OLLAMA_MODEL = 'scripted-coder:1b';
    process.env.AGENTIC_MODEL_LOCK_DB = join(tempDir('cap-'), 'capacity.db');
    process.env.AGENTIC_MODEL_CONCURRENCY = '1';
  });
  after(async () => {
    process.env = saved;
    await server.close();
  });

  test('each task runs in its own spawned process, worktree and routed model; Studio-facing rows show both', async () => {
    try {
      execFileSync('go', ['version']);
    } catch {
      return; // Go toolchain unavailable: nothing to verify against
    }
    const repo = makeRepo({
      'go.mod': 'module example.com/calc\n\ngo 1.21\n',
      'calc/add.go': 'package calc\n\nfunc Add(a, b int) int { return 0 }\n',
      'calc/sub.go': 'package calc\n\nfunc Sub(a, b int) int { return 0 }\n',
      'calc/add_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if Add(2, 3) != 5 { t.Fatal("add") } }\n',
      'calc/sub_test.go': 'package calc\n\nimport "testing"\n\nfunc TestSub(t *testing.T) { if Sub(5, 3) != 2 { t.Fatal("sub") } }\n',
    });
    const store = makeStore();
    const goTask = (id: string, file: string, test: string, testName: string) => ({
      id, title: `implement ${file}`, executor: 'worker' as const,
      request: {
        contract: { taskId: id, objective: `Implement ${file} so ${test} passes.`, allowedFiles: [file], contextFiles: [test], acceptanceCriteria: [`${testName} passes`], verificationCommands: [['go', 'test', '-run', testName, './calc']], constraints: ['tests are immutable; edit only the allowed file'] },
        assessment: { complexity: 'small' as const, risk: 'low' as const, ambiguity: 'none' as const, rationale: 'one pure function' },
      },
    });
    store.createBatch(plan(repo, [goTask('add', 'calc/add.go', 'calc/add_test.go', 'TestAdd'), goTask('sub', 'calc/sub.go', 'calc/sub_test.go', 'TestSub')], { project: 'demo' }), 'lead', { target: resolveTargetRepository(repo) });
    const agents = new AgentStore(store.db);
    const workflow = createCodingTaskWorkflow({ execution: 'process', agentStore: agents, artifactRoot: tempDir('art-'), agentTimeoutMs: 180_000 });
    const resolver = modelResolverFromEnv();
    const scheduler = new Scheduler({
      store, executor: createInProcessExecutor(workflow), workspace: WorktreeManager.targetOwned(), config: { pollMs: 20, maxConcurrentWorkers: 2, workerLeaseTimeoutMs: 120_000, taskTimeoutMs: 180_000 },
      selectModel: async (task) => routeWorkerModel({ taskId: task.id, agentId: 'coding-worker-go', language: 'go', complexity: 'small', risk: 'low' }, resolver, { ollama: await ollamaInventory(server.baseUrl), memoryBudgetGb: localMemoryBudgetGb() }),
    });
    const summary = await scheduler.run();
    const detail = JSON.stringify(store.listTasks().map((t) => [t.id, t.state, t.stateReason]));
    assert.deepEqual(summary.reviewPending.sort(), ['add', 'sub'], detail);

    const rows = agents.list({ batchId: 'B1' });
    assert.equal(rows.length, 2, 'one agent process per task');
    assert.ok(rows.every((r) => r.status === 'COMPLETED' && r.outcome === 'PASS'), JSON.stringify(rows));
    assert.notEqual(rows[0].pid, rows[1].pid);
    assert.ok(rows.every((r) => r.pid !== process.pid), 'never the scheduler or server process');
    assert.ok(rows.every((r) => r.assignedModel === 'ollama/scripted-coder:1b'), 'the routed model was assigned');
    assert.ok(rows.every((r) => r.reportedModel === 'scripted-coder:1b@server'), 'the model identity is what the provider reported');
    assert.ok(rows.every((r) => r.toolCalls >= 1 && r.inferenceMs > 0));
    const target = resolveTargetRepository(repo);
    for (const r of rows) assert.ok(realpathSync(r.worktree).startsWith(target.worktreeRoot + '/'), `${r.worktree} is inside the target repository`);
    assert.notEqual(rows[0].worktree, rows[1].worktree);
    for (const id of ['add', 'sub']) {
      const t = store.requireTask(id);
      assert.equal((t.artifacts.modelRouting as { outcome: string }).outcome, 'selected');
      assert.equal((t.artifacts.agent as { executionId: string }).executionId, rows.find((r) => r.taskId === id)!.executionId);
    }
    const metrics = computeAgentMetrics(store.db, { batchId: 'B1' });
    assert.equal(metrics.agentsSpawned, 2);
    assert.equal(metrics.agentSpawnSuccessRate, 1);
    assert.equal(metrics.executionsByEvidence.providerReportedModel, 2);
    store.close();
  });

  test('a routed model that is not installed is refused before any process is spawned (no substitution)', async () => {
    const resolver = modelResolverFromEnv();
    const decision = routeWorkerModel({ taskId: 'x', agentId: 'coding-worker-go', language: 'go', complexity: 'small', risk: 'low', requested: { providerId: 'ollama', modelId: 'scripted-coder:1b' } }, resolver, { ollama: new Map(), memoryBudgetGb: 8 });
    assert.equal(decision.outcome, 'refused');
    assert.match(decision.reason, /not_installed/);
    assert.equal(decision.selected, null);
  });
});
