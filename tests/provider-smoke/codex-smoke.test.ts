import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findProjectRoot } from '../../src/core/paths.ts';
import { ModelCapacity, defaultModelCapacityPath } from '../../src/runtime/capacity/model-capacity.ts';
import { runCodingTask } from '../../src/runtime/execution/coding-task-runner.ts';
import { makeRepo } from '../../src/runtime/scheduler/test-helpers.ts';
import { createCodexProvider } from '../../src/workers/providers/codex.ts';

/**
 * ONE bounded real Codex call on a disposable repository. Skipped unless the operator opts in:
 *
 *   AGENTIC_REAL_PROVIDER_SMOKE=codex node --disable-warning=ExperimentalWarning --test tests/provider-smoke/codex-smoke.test.ts
 *
 * This spends the operator's Codex quota/credits. Limits: one invocation (1 coding attempt, 0 runtime retries), 5 minute
 * deadline, a throwaway repo under the OS temp dir, the CLI's workspace-write sandbox, no bypass flags, an allowlisted
 * environment. The result is judged by the runtime verifier, not by Codex. A report is written to
 * .workdir/m8.2/codex-smoke.json (measured values only; anything not reported is UNKNOWN).
 */

const enabled = process.env.AGENTIC_REAL_PROVIDER_SMOKE === 'codex';

describe('real Codex smoke (opt-in, one bounded call)', { skip: enabled ? false : 'set AGENTIC_REAL_PROVIDER_SMOKE=codex to spend one Codex call' }, () => {
  it('completes one tiny task inside the worktree, judged by the runtime verifier', async () => {
    const repo = makeRepo({
      'src/double.js': '// double returns n multiplied by two.\nexports.double = function double(n) {\n  throw new Error("not implemented");\n};\n',
    });
    const provider = createCodexProvider({ model: process.env.AGENTIC_CODEX_MODEL || undefined, passEnv: (process.env.AGENTIC_CODEX_PASS_ENV ?? 'CODEX_HOME').split(',').filter(Boolean) });
    const availability = await provider.probe();
    assert.equal(availability.state, 'available', `Codex is not usable: ${availability.state}: ${availability.detail}`);

    const started = Date.now();
    const result = await runCodingTask(
      {
        taskId: 'smoke-double',
        objective: 'Implement exports.double in src/double.js so double(n) returns n * 2. Keep the existing comment.',
        allowedFiles: ['src/double.js'],
        contextFiles: [],
        verificationCommands: [['node', 'check-double.js']],
        hiddenFiles: { 'check-double.js': "const { double } = require('./src/double.js');\nif (double(4) !== 8 || double(-3) !== -6 || double(0) !== 0) { console.error('double is wrong'); process.exit(1); }\n" },
      },
      { repoRoot: repo, worker: provider, maxAttempts: 1, modelTimeoutMs: 300_000, capacity: new ModelCapacity(defaultModelCapacityPath(), { resource: 'codex', permits: 1 }) },
    );

    const source = readFileSync(join(repo, 'src/double.js'), 'utf8');
    const report = {
      at: new Date().toISOString(),
      verdict: result.verdict,
      failureCategory: result.failureCategory ?? null,
      elapsedMs: Date.now() - started,
      attempts: result.attempts,
      runtimeRetries: result.runtimeRetries,
      telemetry: result.records.map((r) => r.telemetry ?? null),
      forbiddenFilesChanged: result.forbiddenFilesChanged,
      commentKept: source.includes('double returns n multiplied by two'),
      error: result.records.at(-1)?.runtimeError ?? null,
    };
    const out = join(findProjectRoot() ?? process.cwd(), '.workdir', 'm8.2');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'codex-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    assert.equal(result.verdict, 'PASS', `runtime verifier did not pass: ${JSON.stringify(report)}`);
    assert.deepEqual(result.forbiddenFilesChanged, []);
  });
});
