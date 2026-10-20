import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

// Isolate the machine-wide permit database for this file before anything opens it.
process.env.AGENTIC_MODEL_LOCK_DB = join(process.env.TMPDIR ?? '/tmp', `autonomy-cap-${process.pid}.db`);

import { Agent } from '@mastra/core/agent';
import { findProjectRoot } from '../../src/core/paths.ts';
import { createCodingTaskWorkflow } from '../../src/integrations/mastra/workflows/coding-task-workflow.ts';
import { createInProcessExecutor } from '../../src/integrations/mastra/__testing__/in-process-executor.ts';
import { scriptedModel, type ScriptStep } from '../../src/integrations/mastra/__testing__/scripted-model.ts';
import { capacityFor } from '../../src/runtime/capacity/model-capacity.ts';
import type { WorkerLike } from '../../src/runtime/execution/coding-task-runner.ts';
import { DurableEngineeringKnowledge, keyringPromotionAuthority } from '../../src/runtime/knowledge/engineering-knowledge-store.ts';
import { keyringOf, testIdentity } from '../../src/runtime/knowledge/__testing__/keys.ts';
import { grantFor } from '../../src/runtime/knowledge/__testing__/promotion.ts';
import { loadPackRegistry } from '../../src/runtime/knowledge/packs/loader.ts';
import { activeSkillDigests, pinSkillsForTask, skillToCandidate } from '../../src/runtime/knowledge/packs/skills.ts';
import { Scheduler } from '../../src/runtime/scheduler/scheduler.ts';
import { git, makeRepo, makeStore, plan, tempDir } from '../../src/runtime/scheduler/test-helpers.ts';
import { createMastraSpecialist } from '../../src/integrations/mastra/specialist-agents.ts';
import { report } from '../../src/integrations/mastra/__testing__/scripted-model.ts';
import { reviewRequestFromTask, runSpecialistReviews } from '../../src/integrations/mastra/specialist-review-runner.ts';
import { createSpecialistReviewWorkflow } from '../../src/integrations/mastra/workflows/specialist-review-workflow.ts';
import { WorktreeManager } from '../../src/runtime/worktree/worktree.ts';
import { gitDiff, gitStatus, runGoFmt, runGoTest } from '../../src/workers/tools/execution-tools.ts';
import { listFiles, readFile, searchFiles, writeFile } from '../../src/workers/tools/repository-tools.ts';

/**
 * Autonomous demonstration (scenarios A and B). What is REAL: scheduler, SQLite store + leases + fencing, isolated git worktrees, the
 * Mastra coding-task-workflow, a Mastra Agent that calls the REAL repository/execution tools, the runtime mutation policy, the sandboxed
 * `go test` verifier, skill promotion/pinning. What is NOT: the model. It is a deterministic scripted model (provider "scripted"), so no
 * model quality, latency, token or cost number from this file is a measurement of Qwen or any real provider. Live provider smoke is deferred.
 * Each scenario writes an evidence record to .workdir/autonomy/<scenario>.json for docs/engineering/autonomous-demonstration-report.md.
 */

const ROOT = findProjectRoot()!;
const EVIDENCE_DIR = join(ROOT, '.workdir', 'autonomy');
const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const WRONG = 'package calc\n\nfunc Double(n int) int {\n\treturn n + 1\n}\n';
const TEST_SRC = 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';
const OBJECTIVE = 'Implement Double and handle errors with context cancellation in this golang package';

const pack = loadPackRegistry(ROOT);
const promoter = testIdentity('k-promoter', 'lead', ['promoter']);
const authority = keyringPromotionAuthority(keyringOf(promoter));

/** One attempt = read, write, verify with the worker's own test tool, report. `contents[i]` is what attempt i writes. */
const attemptScript = (contents: readonly string[]) => (call: number): ScriptStep => {
  const content = contents[Math.min(Math.floor(call / 4), contents.length - 1)]!;
  return [
    { toolCall: { name: 'readFile', args: { path: 'calc/calc.go' } } },
    { toolCall: { name: 'writeFile', args: { path: 'calc/calc.go', content } } },
    { toolCall: { name: 'runGoTest', args: { package: './calc' } } },
    { text: 'done' },
  ][call % 4]! as ScriptStep;
};

interface ToolEvent { callId: string; tool: string; args: unknown; outcome: string }
function toolTrace(prompts: unknown[][]): ToolEvent[] {
  const calls = new Map<string, ToolEvent>();
  for (const prompt of prompts) for (const m of prompt as { role: string; content: unknown }[]) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Record<string, any>[]) {
      if (part.type === 'tool-call' && !calls.has(part.toolCallId)) calls.set(part.toolCallId, { callId: part.toolCallId, tool: part.toolName, args: typeof part.input === 'string' ? JSON.parse(part.input) : part.input, outcome: 'no result seen' });
      if (part.type === 'tool-result') { const e = calls.get(part.toolCallId); if (e) e.outcome = JSON.stringify(part.output?.value ?? part.output).slice(0, 160); }
    }
  }
  return [...calls.values()].map((e) => e.tool === 'writeFile' ? { ...e, args: { path: (e.args as { path: string }).path, contentBytes: Buffer.byteLength((e.args as { content: string }).content) } } : e);
}

async function runScenario(options: { id: string; taskId: string; contents: readonly string[]; pinSkill?: string }) {
  const started = Date.now();
  const repo = makeRepo({ 'go.mod': 'module example.com/calc\n\ngo 1.22\n', 'calc/calc.go': STUB, 'calc/calc_test.go': TEST_SRC });
  const dir = tempDir('autonomy-');
  const scripted = scriptedModel(attemptScript(options.contents));
  const agent = new Agent({
    id: 'coding-worker-go', name: 'Coding Worker (Go)', instructions: 'Implement the delegated change with the provided tools.', model: scripted.model,
    tools: { listFiles, readFile, searchFiles, writeFile, runGoFmt, runGoTest, gitDiff, gitStatus },
  });

  let knowledge: unknown, catalog, skills: { id: string; revision: string; promotedDigest: string | undefined }[] = [], selectionDigest: string | undefined;
  if (options.pinSkill) {
    const store = new DurableEngineeringKnowledge(new DatabaseSync(':memory:'));
    const candidate = skillToCandidate(pack.skillById.get(options.pinSkill)!);
    store.promote(candidate, grantFor(promoter, 'promote', candidate), authority);
    catalog = store.activeCatalog();
    const pin = pinSkillsForTask(pack.skills, catalog, { language: 'go', taskType: 'implement', text: OBJECTIVE });
    knowledge = pin.knowledge;
    const digests = activeSkillDigests(catalog.list());
    skills = pin.selection.selected.map((id) => ({ id, revision: pack.skillById.get(id)!.version, promotedDigest: digests.get(id) }));
    selectionDigest = pin.knowledge?.selectionDigest;
  }

  const workflow = createCodingTaskWorkflow({
    resolveWorker: () => agent as unknown as WorkerLike,
    ...(catalog ? { knowledgeCatalog: catalog } : {}),
    artifactRoot: join(dir, 'artifacts'),
    // A bare worker (no provider descriptor) is attributed to the local default model by design, so the run declares what really ran.
    runOptions: { runtimeRetryDelayMs: 0, modelLabel: 'scripted:scripted-1' },
  });
  const executor = createInProcessExecutor(workflow);
  const store = makeStore();
  store.createBatch(plan(repo, [{
    id: options.taskId, title: 'Implement Double', priority: 50, executor: 'worker', maxClaims: 1,
    request: {
      contract: { taskId: options.taskId, objective: OBJECTIVE, allowedFiles: ['calc/calc.go'], contextFiles: ['calc/calc_test.go'], acceptanceCriteria: ['TestDouble passes'],
        verificationCommands: [['go', 'test', '-count=1', './calc']], constraints: ['tests are immutable'], ...(knowledge ? { knowledge } : {}) },
      assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function with an existing test' },
    },
  }] as never));
  store.promote();
  const scheduler = new Scheduler({
    store, executor, workspace: new WorktreeManager(join(dir, 'worktrees')), capacity: capacityFor(), allowProviders: [], cancelGraceMs: 2_000,
    // 1s leases expired mid-attempt under full-suite load; lease expiry is tested in src/runtime/scheduler (store, multi-worker).
    config: { pollMs: 20, workerLeaseTimeoutMs: 10_000, taskTimeoutMs: 120_000, maxCapacityWaitMs: 120_000 },
  });
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const summary = await scheduler.run();
  const task = store.requireTask(options.taskId);
  const artifactDir = task.artifacts.artifactDir ? String(task.artifacts.artifactDir) : undefined;
  const attempts = artifactDir ? JSON.parse(readFileSync(join(artifactDir, 'attempts.json'), 'utf8')) as { telemetry: Record<string, any>; verification: { exitCode: number | null; command?: string[] } }[] : [];
  const changed = task.headCommit ? git(repo, 'diff', '--name-only', headBefore, task.headCommit).trim().split('\n').filter(Boolean) : [];
  const evidence = {
    schema: 'agentic.autonomy-evidence/1', scenario: options.id, taskId: options.taskId,
    realComponents: ['Scheduler+SchedulerStore(SQLite, leases, fencing)', 'WorktreeManager', 'Mastra coding-task-workflow', 'Mastra Agent + real repository/execution tools', 'runtime mutation policy', 'sandboxed go test verifier'],
    stubbedComponents: ['language model (deterministic scripted model; provider "scripted", model "scripted-1"; NOT Qwen, no network)'],
    agent: { agentId: agent.id, role: 'coding-worker', providerId: 'scripted', modelId: 'scripted-1' },
    skills, selectionDigest, runIds: executor.started, task: { state: task.state, stateReason: task.stateReason, failureCategory: task.failureCategory, claims: task.claims, headCommit: task.headCommit },
    summary: { reviewPending: summary.reviewPending, requeued: summary.requeued },
    codingAttempts: attempts.length, attempts: attempts.map((a) => ({ model: a.telemetry.model, provider: a.telemetry.provider, costUsd: a.telemetry.usage?.costUsd, verifierExitCode: a.verification.exitCode })),
    modelInferenceCalls: scripted.calls(), toolCalls: toolTrace(scripted.prompts() as unknown[][]),
    changedFiles: changed, sourceCheckoutClean: git(repo, 'status', '--porcelain') === '' && git(repo, 'rev-parse', 'HEAD') === headBefore,
    measured: { wallClockMs: Date.now() - started, tokens: 'not measured (scripted model reports constants)', costUsd: 'not measured (UNKNOWN)' },
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, `${options.id}.json`), JSON.stringify(evidence, null, 2));
  return { evidence, task, scripted, repo, headBefore, dir, store };
}

describe('autonomous demonstration: real runtime path, scripted model', () => {
  it('Scenario A (normal completion): pinned skill -> scheduled -> delegated -> real tool calls -> sandboxed verification -> REVIEW_PENDING', async () => {
    const r = await runScenario({ id: 'scenario-a-normal', taskId: 'DEMO-A', contents: [RIGHT], pinSkill: 'go-engineering' });
    const e = r.evidence;
    assert.equal(r.task.state, 'REVIEW_PENDING', `${r.task.state}: ${r.task.stateReason}`);
    assert.equal(e.codingAttempts, 1);
    assert.ok(e.attempts.every((a) => a.model === 'scripted:scripted-1'), 'recorded telemetry names the model that actually ran, never a stand-in');
    assert.equal(e.attempts[0]!.verifierExitCode, 0);
    assert.deepEqual(e.changedFiles, ['calc/calc.go'], 'only the allowed file changed');
    assert.equal(e.sourceCheckoutClean, true);
    assert.deepEqual(e.toolCalls.map((t) => t.tool), ['readFile', 'writeFile', 'runGoTest']);
    assert.ok(e.skills.length >= 1 && e.skills.some((s) => s.id === 'go-engineering'), 'a skill was selected and pinned');
    assert.match(r.scripted.seenText(), /Skill go-engineering@/, 'the pinned skill reached the model prompt');
  });

  it('Scenario B1 (failure then bounded recovery): the verifier rejects attempt 1, the runtime retries once with feedback, attempt 2 passes', async () => {
    const r = await runScenario({ id: 'scenario-b1-recovery', taskId: 'DEMO-B1', contents: [WRONG, RIGHT] });
    const e = r.evidence;
    assert.equal(r.task.state, 'REVIEW_PENDING', `${r.task.state}: ${r.task.stateReason}`);
    assert.equal(e.codingAttempts, 2);
    assert.notEqual(e.attempts[0]!.verifierExitCode, 0, 'attempt 1 was observably wrong');
    assert.equal(e.attempts[1]!.verifierExitCode, 0);
    assert.equal(e.sourceCheckoutClean, true);
  });

  it('Scenario B2 (bounded terminal failure): a worker that never gets it right ends in an explicit non-passing state after a bounded number of attempts', async () => {
    const r = await runScenario({ id: 'scenario-b2-terminal', taskId: 'DEMO-B2', contents: [WRONG] });
    const e = r.evidence;
    assert.notEqual(r.task.state, 'REVIEW_PENDING', 'a wrong implementation is never presented as reviewable');
    assert.ok(e.codingAttempts >= 1 && e.codingAttempts <= 5, `bounded attempts, saw ${e.codingAttempts}`);
    assert.ok(e.attempts.every((a) => a.verifierExitCode !== 0), 'no attempt passed verification');
    assert.equal(e.sourceCheckoutClean, true);
    assert.equal(e.changedFiles.length, 0, 'nothing from a failed task reached a commit');
  });

  it('Scenario A+ (chain): the task the scheduler verified is handed to read-only specialists, which return advisories only and change nothing', async () => {
    const r = await runScenario({ id: 'scenario-a-plus-chain', taskId: 'DEMO-AP', contents: [RIGHT] });
    assert.equal(r.task.state, 'REVIEW_PENDING');
    const model = scriptedModel([{ toolCall: { name: 'readFile', args: { path: 'calc/calc.go' } } }, { text: report() }]);
    const workflow = createSpecialistReviewWorkflow({
      registry: pack, allowedRoots: () => [join(r.dir, 'worktrees')], contextTokens: () => 16_384,
      resolveAgent: (manifest) => createMastraSpecialist(manifest, { model: model.model }) as never,
    });
    const before = git(r.task.worktreePath!, 'status', '--porcelain') + git(r.task.worktreePath!, 'rev-parse', 'HEAD');
    const started = Date.now();
    const summary = await runSpecialistReviews({ workflow, registry: pack, prefer: ['security-reviewer', 'go-reviewer'] }, reviewRequestFromTask(r.task as never, { language: 'go' }));
    const after = git(r.task.worktreePath!, 'status', '--porcelain') + git(r.task.worktreePath!, 'rev-parse', 'HEAD');
    assert.equal(summary.advisory, true);
    assert.ok(summary.runs.length >= 1 && summary.runs.length <= 3);
    assert.deepEqual(summary.selected.slice(0, 2), ['security-reviewer', 'go-reviewer'], 'the lead\'s priority order was honoured');
    assert.ok(summary.runs.every((x) => x.status === 'REPORTED'), JSON.stringify(summary.runs));
    assert.equal(after, before, 'read-only specialists changed nothing in the task worktree');
    const stateAfter = r.store.requireTask('DEMO-AP').state; // re-read from the durable store after the specialists ran
    assert.equal(stateAfter, 'REVIEW_PENDING', 'a specialist advisory never moves the task out of review');
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, 'scenario-a-plus-specialists.json'), JSON.stringify({
      schema: 'agentic.autonomy-evidence/1', scenario: 'scenario-a-plus-chain', taskId: 'DEMO-AP', schedulerRunIds: r.evidence.runIds,
      stubbedComponents: ['specialist language model (scripted)'], advisory: summary.advisory, reviewId: summary.reviewId, selected: summary.selected, skippedForCap: summary.skippedForCap,
      runs: summary.runs, modelInferenceCalls: model.calls(), taskStateAfter: stateAfter, worktreeUnchanged: after === before,
      measured: { specialistWallClockMs: Date.now() - started, tokens: 'not measured (scripted)', costUsd: 'not measured' },
    }, null, 2));
  });
});
