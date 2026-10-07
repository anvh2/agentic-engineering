import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, type CodingTask, type WorkerLike } from './coding-task-runner.ts';

/**
 * Verification executes worker-written code (the allowed file is imported by the tests). The mutation policy used to be
 * checked only BEFORE verification, and afterwards only the allowed files were re-hashed, so anything that code wrote
 * elsewhere in the repository during the test run slipped through a PASS. In delegate mode (the user's real checkout)
 * nothing else would catch it.
 */
describe('runCodingTask: side effects of verification', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runner-side-effects-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'impl.js'), 'module.exports = 0;\n');
    await writeFile(join(root, 'src', 'other.js'), 'module.exports = "untouched";\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const task = (verify: string): CodingTask => ({
    taskId: 'side-effects',
    objective: 'implement',
    allowedFiles: ['src/impl.js'],
    verificationCommands: [['node', '-e', verify]],
    constraints: ['tests are immutable'],
  });
  const worker: WorkerLike = {
    async generate() {
      await writeFile(join(root, 'src', 'impl.js'), 'module.exports = 1;\n');
      return { text: 'done', finishReason: 'stop', steps: [{}] };
    },
  };

  it('a verification run that modifies a file outside the allowed set is not a PASS', async () => {
    // stands in for worker code executed by the test runner: it passes, but rewrites another source file on the way
    const result = await runCodingTask(task("require('fs').writeFileSync('src/other.js','module.exports = \"pwned\";\\n')"), { repoRoot: root, worker, maxAttempts: 1 });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failureCategory, 'D_forbidden_mutation');
    assert.deepEqual(result.forbiddenFilesChanged, ['src/other.js']);
  });

  it('a verification run that creates a new file is not a PASS either', async () => {
    const result = await runCodingTask(task("require('fs').writeFileSync('src/dropped.js','x')"), { repoRoot: root, worker, maxAttempts: 1 });
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(result.forbiddenFilesChanged, ['src/dropped.js']);
  });

  it('a clean verification still passes, and temporary files the tests remove themselves are fine', async () => {
    const result = await runCodingTask(task("const fs=require('fs');fs.writeFileSync('src/tmp.txt','x');fs.rmSync('src/tmp.txt')"), { repoRoot: root, worker, maxAttempts: 1 });
    assert.equal(result.verdict, 'PASS');
    assert.equal(await readFile(join(root, 'src', 'other.js'), 'utf8'), 'module.exports = "untouched";\n');
  });
});
