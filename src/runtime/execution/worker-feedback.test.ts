import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { runCodingTask, type CodingTask, type WorkerLike } from './coding-task-runner.ts';
import { scrubForWorker } from './worker-feedback.ts';

/**
 * Verifier output is an input to the next worker attempt. The sandbox keeps credentials out of what worker-written code can read; this
 * is the second control on that channel: host identity (home path, user, host name, temp and repository paths) does not travel, terminal
 * escapes and control characters do not, and the text that tells the worker what failed does.
 */

describe('scrubForWorker (pure)', () => {
  const home = homedir();
  const user = userInfo().username;
  const host = hostname().split('.')[0];

  it('replaces the repository, temp and home paths, the user name and the host name', () => {
    const text = `panic at /work/tree/calc/calc.go:7 in ${home}/go/src/x.go by ${user}@${host}.local; tmp ${tmpdir()}/agentic-sbx-abc123/go-build`;
    const out = scrubForWorker(text, { roots: { '/work/tree': '<repo>' } });
    assert.ok(out.includes('<repo>/calc/calc.go:7'), out);
    assert.ok(!out.includes(home), out);
    assert.ok(!new RegExp(`(?<![A-Za-z0-9_-])${user}(?![A-Za-z0-9_-])`).test(out), `user name removed: ${out}`);
    assert.ok(!out.toLowerCase().includes(host.toLowerCase()), out);
    assert.ok(!out.includes(tmpdir()), out);
    assert.match(out, /<tmp>\/agentic-sbx-abc123\/go-build/);
  });

  it('turns any other absolute path into a user, volume, Homebrew or system location into <host-path>, and leaves ordinary text alone', () => {
    const out = scrubForWorker('open /Users/someone/.ssh/id_rsa: denied\n/opt/homebrew/Cellar/go@1.25/1.25.10/libexec/src/testing/testing.go:1\nsee /usr/bin/env and calc_test.go:12: got 1 want 2');
    assert.doesNotMatch(out, /\/Users\/someone|\/opt\/homebrew/);
    assert.match(out, /<host-path>/);
    assert.match(out, /calc_test\.go:12: got 1 want 2/, 'the assertion text the worker needs is untouched');
    assert.match(out, /\/usr\/bin\/env/, 'a plain system path is not host identity');
  });

  it('strips terminal escapes and control characters and redacts token shapes', () => {
    const out = scrubForWorker('\u001b[31mFAIL\u001b[0m\u0007 \u001b]0;title\u0007ok\u0000end Bearer abcdefgh12345678 sk-abcdefghijklmnop12345');
    assert.equal(out.includes('\u001b'), false);
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out), false);
    assert.match(out, /FAIL/);
    assert.doesNotMatch(out, /abcdefgh12345678|sk-abcdefghijklmnop/);
  });

  it('is idempotent and never grows the text', () => {
    const once = scrubForWorker(`in ${home}/x by ${user}`);
    assert.equal(scrubForWorker(once), once);
    assert.ok(once.length <= `in ${home}/x by ${user}`.length + 20);
  });
});

describe('the retry prompt a worker receives after a failed verification', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-')));
    await mkdir(join(root, 'calc'));
    await writeFile(join(root, 'go.mod'), 'module example.com/calc\n\ngo 1.22\n');
    await writeFile(join(root, 'calc', 'calc.go'), 'package calc\n\nfunc Double(n int) int {\n\treturn 0\n}\n');
    await writeFile(
      join(root, 'calc', 'calc_test.go'),
      `package calc

import (
	"fmt"
	"os"
	"testing"
)

func TestDouble(t *testing.T) {
	// what verifier-run code can reveal about the host: all of it must be scrubbed before the next attempt sees it
	cwd, _ := os.Getwd()
	host, _ := os.Hostname()
	fmt.Printf("IDENTITY cwd=%s home=%s tmp=%s host=%s user=%s\\n", cwd, os.Getenv("HOME"), os.TempDir(), host, os.Getenv("USER"))
	if got := Double(3); got != 6 {
		t.Fatalf("Double(3) = %d, want 6", got)
	}
}
`,
    );
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const task: CodingTask = {
    taskId: 'T-fb',
    objective: 'Implement Double',
    allowedFiles: ['calc/calc.go'],
    contextFiles: ['calc/calc_test.go'],
    acceptanceCriteria: ['TestDouble passes'],
    verificationCommands: [['go', 'test', '-count=1', './calc']],
    constraints: ['tests are immutable'],
  };

  it('contains what failed, and none of the host identity the verified code printed', async () => {
    const prompts: string[] = [];
    let call = 0;
    const worker: WorkerLike = {
      async generate(prompt) {
        call += 1;
        prompts.push(prompt);
        // attempt 1 is wrong on purpose; attempt 2 is right
        await writeFile(join(root, 'calc', 'calc.go'), `package calc\n\nfunc Double(n int) int {\n\treturn n * ${call === 1 ? 1 : 2}\n}\n`);
        return { text: 'done', finishReason: 'stop', steps: [{}] };
      },
    };
    const result = await runCodingTask(task, { repoRoot: root, worker });
    assert.equal(result.verdict, 'PASS');
    assert.equal(prompts.length, 2);
    const retry = prompts[1];
    assert.match(retry, /Verifier output:/);
    assert.match(retry, /Double\(3\) = 3, want 6/, 'the failure the worker must fix is there');
    assert.match(retry, /IDENTITY cwd=<repo>/, 'the repository path is a placeholder');
    // the raw record (a local artifact) keeps the real values; only the prompt is scrubbed
    assert.match(result.records[0].verification?.output ?? '', new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the local record is untouched');
    const home = await realpath(homedir());
    assert.ok(!retry.includes(root), 'no repository path');
    assert.ok(!retry.includes(home), 'no home path');
    assert.ok(!retry.includes(await realpath(tmpdir())), 'no temp path');
    assert.ok(!retry.toLowerCase().includes(hostname().split('.')[0].toLowerCase()), 'no host name');
    assert.ok(!new RegExp(`(?<![A-Za-z0-9_-])${userInfo().username}(?![A-Za-z0-9_-])`).test(retry), 'no user name');
  });
});
