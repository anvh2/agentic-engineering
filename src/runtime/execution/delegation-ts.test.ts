import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { routeTask, validateTypeScriptVerification, type DelegationRequest } from './delegation.ts';
import { runCodingTask, type WorkerLike } from './coding-task-runner.ts';

const implementation = 'src/util/value.ts';
const testFile = 'src/util/value.test.ts';
const compiler = ['node', './node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--project', 'tsconfig.json'];
const tests = ['node', '--experimental-strip-types', '--test', testFile];
const request = (verificationCommands: string[][] = [compiler, tests]): DelegationRequest => ({
  contract: {
    taskId: 'ts-fixture',
    objective: 'Update a TypeScript implementation using its immutable test oracle',
    allowedFiles: [implementation],
    contextFiles: [testFile],
    acceptanceCriteria: ['the immutable test passes'],
    verificationCommands,
    constraints: ['tests are immutable and must not be changed', 'no dependency changes'],
  },
  assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'bounded single package change' },
});

describe('typescript-strict-v1 verifier profile', () => {
  let root: string;
  let previousFlag: string | undefined;

  beforeEach(async () => {
    previousFlag = process.env.AGENTIC_TS_DELEGATION;
    delete process.env.AGENTIC_TS_DELEGATION;
    root = await mkdtemp(join(tmpdir(), 'agentic-ts-verifier-'));
    await mkdir(join(root, 'src/util'), { recursive: true });
    await mkdir(join(root, 'node_modules/typescript/bin'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"fixture","devDependencies":{"typescript":"5.9.3"}}\n');
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { name: 'fixture' }, 'node_modules/typescript': { version: '5.9.3' } } }));
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*.ts"]}\n');
    await writeFile(join(root, implementation), 'export const value = 1;\n');
    await writeFile(join(root, testFile), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.ts';\ntest('value', () => assert.equal(value, 1));\n");
    await writeFile(join(root, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"5.9.3"}\n');
    await writeFile(join(root, 'node_modules/typescript/bin/tsc'), '# local pinned compiler fixture\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousFlag === undefined) delete process.env.AGENTIC_TS_DELEGATION;
    else process.env.AGENTIC_TS_DELEGATION = previousFlag;
  });

  it('accepts only the exact local compiler and immutable Node test profile', async () => {
    const reasons = await validateTypeScriptVerification([compiler, tests], request().contract, root);
    assert.deepEqual(reasons, []);
  });

  it('rejects shell, package manager, network-capable, and alternate compiler commands', async () => {
    for (const invalid of [
      ['sh', '-c', 'tsc --noEmit'],
      ['npx', 'tsc', '--noEmit'],
      ['npm', 'run', 'typecheck'],
      ['node', '-e', 'process.exit(0)'],
      ['node', './node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--pretty', 'false', '--project', 'tsconfig.json'],
    ]) {
      const reasons = await validateTypeScriptVerification([invalid, tests], request().contract, root);
      assert.ok(reasons.length > 0, `${invalid.join(' ')} must be rejected`);
    }
  });

  it('rejects untracked, symlinked and non-.test.ts test inputs', async () => {
    const untracked = 'src/util/new.test.ts';
    await writeFile(join(root, untracked), 'test(\'x\', () => {});\n');
    let reasons = await validateTypeScriptVerification([compiler, ['node', '--experimental-strip-types', '--test', untracked]], request().contract, root);
    assert.match(reasons.join('\n'), /not tracked/);

    const link = 'src/util/link.test.ts';
    await symlink('value.test.ts', join(root, link));
    reasons = await validateTypeScriptVerification([compiler, ['node', '--experimental-strip-types', '--test', link]], request().contract, root);
    assert.match(reasons.join('\n'), /symlink/);

    reasons = await validateTypeScriptVerification([compiler, ['node', '--experimental-strip-types', '--test', 'src/util/value.ts']], request().contract, root);
    assert.match(reasons.join('\n'), /must end in \.test\.ts/);
  });

  it('rejects implementation files that cross package boundaries', async () => {
    await mkdir(join(root, 'src/other'), { recursive: true });
    await writeFile(join(root, 'src/other/package.json'), '{"name":"other"}\n');
    await writeFile(join(root, 'src/other/tsconfig.json'), '{"compilerOptions":{"strict":true}}\n');
    const contract = { ...request().contract, allowedFiles: [implementation, 'src/other/other.ts'] };
    const reasons = await validateTypeScriptVerification([compiler, tests], contract, root);
    assert.match(reasons.join('\n'), /one package boundary/);
  });

  it('requires the local installed compiler to match the pinned lockfile version', async () => {
    await writeFile(join(root, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"5.9.4"}\n');
    const reasons = await validateTypeScriptVerification([compiler, tests], request().contract, root);
    assert.match(reasons.join('\n'), /exactly match a local npm lockfile entry/);
  });

  it('keeps the route closed by default even with a valid TS contract', async () => {
    const route = await routeTask(request(), root);
    assert.equal(route.route, 'claude');
    assert.match((route as { reasons: string[] }).reasons.join('\n'), /AGENTIC_TS_DELEGATION=true/);
  });

  it('keeps the runner closed when called directly, bypassing routeTask', async () => {
    let invoked = false;
    const worker: WorkerLike = { async generate() { invoked = true; return { steps: [{}] }; } };
    await assert.rejects(runCodingTask(request().contract, { repoRoot: root, worker }), /TypeScript delegation is disabled/);
    assert.equal(invoked, false);
  });

  it('revalidates the TS verifier profile inside the runner', async () => {
    const previous = process.env.AGENTIC_TS_DELEGATION;
    process.env.AGENTIC_TS_DELEGATION = 'true';
    try {
      const worker: WorkerLike = { async generate() { throw new Error('worker must not be invoked'); } };
      await assert.rejects(runCodingTask({ ...request().contract, verificationCommands: [['node', '-e', 'process.exit(0)']] }, { repoRoot: root, worker }), /typescript-strict-v1 refused the task/);
    } finally {
      if (previous === undefined) delete process.env.AGENTIC_TS_DELEGATION;
      else process.env.AGENTIC_TS_DELEGATION = previous;
    }
  });

  it('does not treat a dirty immutable test oracle as trusted evidence', async () => {
    await writeFile(join(root, testFile), '// changed after commit\n');
    const reasons = await validateTypeScriptVerification([compiler, tests], request().contract, root);
    assert.match(reasons.join('\n'), /dirty and cannot serve as an immutable oracle/);
    assert.match(await readFile(join(root, 'tsconfig.json'), 'utf8'), /strict/);
  });
});
