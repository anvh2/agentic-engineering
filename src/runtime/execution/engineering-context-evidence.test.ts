import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, type CodingTask, type WorkerLike } from './coding-task-runner.ts';
import { ENGINEERING_CONTEXT_ARTIFACT, persistRun } from './coding-task-artifacts.ts';
import { verifyEngineeringContext } from './engineering-context.ts';
import { approvedTask } from './__testing__/approval-fixture.ts';

/** The engineering context workers consume is pinned once per run and recorded as execution evidence. */

const STUB = 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n';
const WRONG = 'package calc\n\nfunc Double(n int) int {\n\treturn n + 1\n}\n';
const RIGHT = 'package calc\n\nfunc Double(n int) int {\n\treturn n * 2\n}\n';
const TEST_SRC = 'package calc\n\nimport "testing"\n\nfunc TestDouble(t *testing.T) {\n\tif got := Double(3); got != 6 {\n\t\tt.Fatalf("Double(3) = %d, want 6", got)\n\t}\n}\n';
const design = { hld: 'The scheduler owns capacity.', lld: 'Never exceed two permits.', adr: ['No Oracle access.'] };
const task: CodingTask = {
  taskId: 'T-CTX',
  objective: 'Implement Double',
  allowedFiles: ['calc/calc.go'],
  contextFiles: ['calc/calc_test.go'],
  acceptanceCriteria: ['TestDouble passes'],
  verificationCommands: [['go', 'test', '-count=1', './calc']],
  constraints: ['tests are immutable'],
};

describe('engineering context execution evidence', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ctx-evidence-'));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), STUB);
    await writeFile(join(root, 'calc', 'calc_test.go'), TEST_SRC);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const worker = (prompts: string[], solve: (call: number) => string): WorkerLike => {
    let call = 0;
    return {
      async generate(prompt) {
        call += 1;
        prompts.push(prompt);
        await writeFile(join(root, 'calc', 'calc.go'), solve(call));
        return { text: 'done', finishReason: 'stop', steps: [{}] };
      },
    };
  };

  it('pins one snapshot for the whole run: the same fingerprint is in every prompt, attempt record and the trace', async () => {
    const prompts: string[] = [];
    const a = approvedTask('T-CTX', ['calc/calc.go'], design);
    const result = await runCodingTask({ ...task, approvedDesign: a.approvedDesign }, { repoRoot: root, approvals: a.verifier, worker: worker(prompts, (call) => (call === 1 ? WRONG : RIGHT)) });
    assert.equal(result.verdict, 'PASS');
    assert.equal(prompts.length, 2);
    const context = result.engineeringContext!;
    assert.deepEqual(verifyEngineeringContext(context), { ok: true });
    for (const prompt of prompts) assert.ok(prompt.includes(context.text), 'the exact pinned text reached the worker');
    assert.deepEqual(result.records.map((r) => r.engineeringContextFingerprint), [context.fingerprint, context.fingerprint]);
    const started = result.events.find((e) => e.type === 'task_started')!;
    assert.equal((started.data.engineeringContext as { fingerprint: string }).fingerprint, context.fingerprint);
    const approval = (started.data.engineeringContext as { approval: { status: string; approvalId: string; role: string; approverId: string; revision: number } }).approval;
    assert.deepEqual({ status: approval.status, approvalId: approval.approvalId, role: approval.role, approverId: approval.approverId, revision: approval.revision }, { status: 'verified', approvalId: a.approvalId, role: 'engineering-lead', approverId: 'lead-1', revision: 1 });
  });

  it('persists the snapshot, its fingerprint and the verified approval with the run artifacts', async () => {
    const a = approvedTask('T-CTX', ['calc/calc.go'], design);
    const result = await runCodingTask({ ...task, approvedDesign: a.approvedDesign }, { repoRoot: root, approvals: a.verifier, worker: worker([], () => RIGHT) });
    const dir = join(root, '.artifacts');
    await persistRun(dir, { taskId: task.taskId }, { ...task, approvedDesign: a.approvedDesign }, result);
    const snapshot = JSON.parse(await readFile(join(dir, ENGINEERING_CONTEXT_ARTIFACT), 'utf8'));
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.fingerprint, result.engineeringContext!.fingerprint);
    assert.equal(snapshot.approval.status, 'verified');
    assert.equal(snapshot.approval.approvalId, a.approvalId);
    assert.deepEqual(snapshot.attemptFingerprints, [{ attempt: 1, fingerprint: snapshot.fingerprint }]);
    assert.deepEqual(verifyEngineeringContext(snapshot), { ok: true }, 'the persisted snapshot is independently re-verifiable');
    const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'));
    assert.equal(summary.engineeringContextFingerprint, snapshot.fingerprint);
    assert.equal(summary.designApproval, 'verified');
  });

  it('a legacy task with no design is explicitly unapproved in its evidence', async () => {
    const result = await runCodingTask(task, { repoRoot: root, worker: worker([], () => RIGHT) });
    assert.deepEqual(result.engineeringContext!.approval, { status: 'none' });
    assert.equal(result.engineeringContext!.design, null);
  });

  it('records no context when no registered language applies (legacy fixtures keep working)', async () => {
    await writeFile(join(root, 'note.txt'), 'x\n');
    const prompts: string[] = [];
    const w: WorkerLike = { async generate(prompt) { prompts.push(prompt); return { text: 'done', finishReason: 'stop', steps: [{}] }; } };
    const result = await runCodingTask({ ...task, allowedFiles: ['note.txt'], contextFiles: [], verificationCommands: [['true']] }, { repoRoot: root, worker: w, maxAttempts: 1 });
    assert.equal(result.engineeringContext, undefined);
    assert.equal(result.records[0].engineeringContextFingerprint, undefined);
    assert.doesNotMatch(prompts[0], /Engineering context SHA-256/);
  });
});
