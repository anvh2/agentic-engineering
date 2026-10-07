import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, type CodingTask, type WorkerLike } from './coding-task-runner.ts';

// The oracle fails unless the file ends with a newline AND has the right logic: it can only pass if the runtime
// restored the EOF newline the "worker" dropped, and the resulting diff must contain no EOF-newline noise.
const ORACLE = `const fs = require('fs');
const src = fs.readFileSync('f.js', 'utf8');
if (!src.endsWith('\\n')) { console.error('missing final newline'); process.exit(1); }
if (!/return 2;/.test(src)) { console.error('wrong logic'); process.exit(1); }`;

const task: CodingTask = {
  taskId: 'EOF-1',
  objective: 'make f return 2',
  allowedFiles: ['f.js'],
  contextFiles: [],
  acceptanceCriteria: ['f returns 2'],
  verificationCommands: [['node', 'check.hidden.js']],
  constraints: ['tests are immutable'],
  hiddenFiles: { 'check.hidden.js': ORACLE },
};

describe('runCodingTask: runtime-owned EOF newline normalization (non-Go files)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runner-eof-'));
    await writeFile(join(root, 'f.js'), 'function f() {\n  return 1;\n}\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const workerWriting = (content: string): WorkerLike => ({
    async generate() {
      await writeFile(join(root, 'f.js'), content);
      return { text: 'done', finishReason: 'stop', steps: [{}] };
    },
  });

  it('restores the final newline a whole-file rewrite dropped, so the one-byte noise never reaches the diff', async () => {
    const result = await runCodingTask(task, { repoRoot: root, worker: workerWriting('function f() {\n  return 2;\n}') });
    assert.equal(result.verdict, 'PASS');
    assert.equal(await readFile(join(root, 'f.js'), 'utf8'), 'function f() {\n  return 2;\n}\n');
    assert.doesNotMatch(result.finalDiff, /No newline at end of file/);
    assert.ok(result.events.some((e) => e.type === 'verification_finished' && (e.data.command as string[])[0] === 'normalize-eof'));
  });

  it('does nothing when the EOF state already matches (no spurious mutation event)', async () => {
    const result = await runCodingTask(task, { repoRoot: root, worker: workerWriting('function f() {\n  return 2;\n}\n') });
    assert.equal(result.verdict, 'PASS');
    assert.ok(!result.events.some((e) => e.type === 'verification_finished' && (e.data.command as string[])[0] === 'normalize-eof'));
  });

  it('a wrong implementation is still a FAIL: normalization never turns a failing change into a pass', async () => {
    const result = await runCodingTask(task, { repoRoot: root, worker: workerWriting('function f() {\n  return 3;\n}'), maxAttempts: 1 });
    assert.equal(result.verdict, 'FAIL');
  });
});
