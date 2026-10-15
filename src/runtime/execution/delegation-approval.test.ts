import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegateCodingTask, routeTask, type DelegationRequest } from './delegation.ts';
import type { WorkerLike } from './coding-task-runner.ts';
import { approvedTask } from './__testing__/approval-fixture.ts';

/** Routing refuses an attached design the runtime cannot verify; legacy requests are untouched. */

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const design = { hld: 'The util module is pure.', lld: 'double(n) returns n * 2 without I/O.' };
const FILE = 'src/util/double.js';

const request = (approvedDesign?: DelegationRequest['contract']['approvedDesign']): DelegationRequest => ({
  contract: {
    taskId: 'JS-APP',
    objective: 'Implement double',
    allowedFiles: [FILE],
    contextFiles: ['src/util/tests/unit/double.test.js'],
    acceptanceCriteria: ['double(3) === 6'],
    verificationCommands: [['npx', '--no-install', 'jest', '--runInBand', 'src/util/tests/unit/double.test.js']],
    constraints: ['tests are immutable'],
    ...(approvedDesign ? { approvedDesign } : {}),
  },
  assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one pure function' },
});
const reasons = (route: Awaited<ReturnType<typeof routeTask>>) => (route.route === 'claude' ? route.reasons.join('\n') : '');

describe('routing with an attached design', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-approval-'));
    await mkdir(join(root, 'src/util/tests/unit'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(root, FILE), 'module.exports = (n) => 0;\n');
    await writeFile(join(root, 'src/util/tests/unit/double.test.js'), "const d = require('../../double');\ntest('d', () => expect(d(3)).toBe(6));\n");
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('clears a task whose attached design verifies', async () => {
    const a = approvedTask('JS-APP', [FILE], design);
    assert.deepEqual(await routeTask(request(a.approvedDesign), root, undefined, { approvals: a.verifier }), { route: 'qwen' });
  });

  it('keeps the task with Claude when no verifier is configured (production default), whatever the approvalRef says', async () => {
    const a = approvedTask('JS-APP', [FILE], design);
    const route = await routeTask(request(a.approvedDesign), root);
    assert.equal(route.route, 'claude');
    assert.match(reasons(route), /approved design rejected \(authority_unconfigured\)/);
  });

  it('keeps the task with Claude for a forged, edited or revoked-by-edit approval', async () => {
    const a = approvedTask('JS-APP', [FILE], design);
    const forged = await routeTask(request({ ...design, approvalRef: 'ADR-14@forged' }), root, undefined, { approvals: a.verifier });
    assert.match(reasons(forged), /approval_unknown/);
    const edited = await routeTask(request({ ...a.approvedDesign, lld: 'double(n) may call the network.' }), root, undefined, { approvals: a.verifier });
    assert.match(reasons(edited), /design_mismatch/);
    const otherFiles = request(a.approvedDesign);
    otherFiles.contract.allowedFiles = ['src/util/triple.js'];
    assert.match(reasons(await routeTask(otherFiles, root, undefined, { approvals: a.verifier })), /task_mismatch/);
  });

  it('a legacy request without a design never consults the verifier', async () => {
    const route = await routeTask(request(), root, undefined, { approvals: () => { throw new Error('must not be consulted'); } });
    assert.deepEqual(route, { route: 'qwen' });
  });

  it('delegateCodingTask hands a forged design back to Claude without invoking the worker', async () => {
    let calls = 0;
    const worker: WorkerLike = { async generate() { calls += 1; return { text: 'x', finishReason: 'stop', steps: [{}] }; } };
    const result = await delegateCodingTask(request({ ...design, approvalRef: 'da-' + '0'.repeat(32) }), { repoRoot: root, worker, approvals: approvedTask('JS-APP', [FILE], design).verifier });
    assert.equal(result.status, 'KEPT_BY_CLAUDE');
    assert.match(result.reasons.join('\n'), /approval_unknown/);
    assert.equal(calls, 0);
  });
});
