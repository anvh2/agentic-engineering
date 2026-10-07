import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessMetrics, sanitizeLabel } from './metrics.ts';
import { createMetricsRoute } from './metrics-route.ts';
import { runCodingTask, type WorkerLike } from '../workflows/coding-task-runner.ts';

const sample = async (m: ReturnType<typeof createHarnessMetrics>, name: string, labels: Record<string, string> = {}) => {
  const base = name.replace(/_(sum|count|bucket)$/, '');
  const metric = (await m.registry.getMetricsAsJSON()).find((x) => x.name === base);
  const hit = (metric?.values as { value: number; labels: Record<string, string>; metricName?: string }[] | undefined)?.find(
    (v) => (v.metricName ?? name) === name && Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return hit?.value;
};

describe('harness metrics', () => {
  it('counts workflow runs by status and times them with the injected clock', async () => {
    let t = 0;
    const m = createHarnessMetrics({ now: () => t });
    m.workflowStarted('wf', 'run-1');
    t = 12_000;
    m.workflowFinished('wf', 'run-1', 'success');
    m.workflowFinished('wf', 'run-2', 'failed'); // no recorded start: counted, no duration
    assert.equal(await sample(m, 'workflow_runs_total', { workflow: 'wf', status: 'success' }), 1);
    assert.equal(await sample(m, 'workflow_runs_total', { workflow: 'wf', status: 'failed' }), 1);
    assert.equal(await sample(m, 'workflow_duration_seconds_count', { workflow: 'wf' }), 1);
    assert.equal(await sample(m, 'workflow_duration_seconds_sum', { workflow: 'wf' }), 12);
  });

  it('records worker, attempt, retry and verification metrics', async () => {
    const m = createHarnessMetrics();
    m.workerTask('qwen3:8b', 'pass');
    m.workerInference('qwen3:8b', 2.5, 'ok');
    m.codingAttempt('fail');
    m.retry('runtime');
    m.retry('coding');
    m.verification(0.4, 'timeout');
    assert.equal(await sample(m, 'worker_tasks_total', { worker: 'qwen3:8b', outcome: 'pass' }), 1);
    assert.equal(await sample(m, 'worker_inference_seconds_sum', { outcome: 'ok' }), 2.5);
    assert.equal(await sample(m, 'coding_attempts_total', { outcome: 'fail' }), 1);
    assert.equal(await sample(m, 'worker_retries_total', { kind: 'runtime' }), 1);
    assert.equal(await sample(m, 'worker_retries_total', { kind: 'coding' }), 1);
    assert.equal(await sample(m, 'verification_duration_seconds_count', { outcome: 'timeout' }), 1);
  });

  it('keeps label cardinality bounded: unknown enum values collapse, free-form labels are sanitized', async () => {
    const m = createHarnessMetrics();
    m.workflowFinished('wf', 'r', 'weird-status-123');
    m.workerTask('/Users/me/secret repo/path with spaces and a very long name '.repeat(5), 'pass');
    assert.equal(await sample(m, 'workflow_runs_total', { status: 'other' }), 1);
    const text = await m.render();
    assert.ok(!text.includes('/Users/me'));
    assert.ok(sanitizeLabel('a b/c').length > 0 && !/[ /]/.test(sanitizeLabel('a b/c')));
    assert.ok(sanitizeLabel('x'.repeat(500)).length <= 64);
  });

  it('never throws into the caller when a metric update fails, and counts the failure', async () => {
    const m = createHarnessMetrics();
    assert.doesNotThrow(() => m.verification(Number.NaN, 'pass'));
    assert.doesNotThrow(() => m.workerInference('w', 1, 'ok'));
    // A broken registry entry: invalid label value type forces prom-client to throw inside the recorder.
    assert.ok(((await sample(m, 'metrics_instrumentation_errors_total')) ?? 0) >= 1);
  });

  it('bounds tracked workflow starts so a run that never finishes cannot leak', async () => {
    const m = createHarnessMetrics();
    for (let i = 0; i < 1_500; i += 1) m.workflowStarted('wf', `r${i}`);
    m.workflowFinished('wf', 'r0', 'success'); // evicted: counted without duration
    m.workflowFinished('wf', 'r1499', 'success');
    assert.equal(await sample(m, 'workflow_runs_total', { status: 'success' }), 2);
    assert.equal(await sample(m, 'workflow_duration_seconds_count', { workflow: 'wf' }), 1);
  });

  it('renders valid Prometheus exposition text with no task content', async () => {
    const m = createHarnessMetrics();
    m.workerTask('qwen3:8b', 'fail');
    m.workflowFinished('wf', 'r', 'success');
    const text = await m.render();
    assertValidExposition(text);
    assert.match(text, /# TYPE worker_tasks_total counter/);
    assert.match(text, /worker_tasks_total\{worker="qwen3:8b",outcome="fail"\} 1/);
  });

  it('/metrics route serves exposition format, and a render failure is a 500, not a crash', async () => {
    const m = createHarnessMetrics();
    m.codingAttempt('pass');
    const route = createMetricsRoute(m) as unknown as { handler: (c: unknown) => Promise<Response> };
    const ctx = {
      body: (b: string, status: number, headers: Record<string, string>) => new Response(b, { status, headers }),
      text: (b: string, status: number) => new Response(b, { status }),
    };
    const ok = await route.handler(ctx);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') ?? '', /text\/plain/);
    assertValidExposition(await ok.text());
    const broken = createMetricsRoute({ render: async () => { throw new Error('boom'); }, contentType: 'text/plain; version=0.0.4; charset=utf-8' }) as unknown as typeof route;
    assert.equal((await broken.handler(ctx)).status, 500);
  });
});

describe('runner instrumentation', () => {
  it('a verified PASS records inference, verification, attempt and task metrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metrics-runner-'));
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'a.txt'), 'old\n');
      const worker: WorkerLike = {
        async generate() {
          await writeFile(join(root, 'src', 'a.txt'), 'new\n');
          return { text: 'done', finishReason: 'stop', steps: [{}] };
        },
      };
      const task = {
        taskId: 'T-metrics',
        objective: 'change a.txt',
        allowedFiles: ['src/a.txt'],
        verificationCommands: [['node', '-e', "process.exit(require('fs').readFileSync('src/a.txt','utf8')==='new\\n'?0:1)"]],
      };
      const m = createHarnessMetrics();
      const result = await runCodingTask(task, { repoRoot: root, worker, metrics: m, modelLabel: 'test-model' });
      assert.equal(result.verdict, 'PASS');
      assert.equal(await sample(m, 'worker_tasks_total', { worker: 'test-model', outcome: 'pass' }), 1);
      assert.equal(await sample(m, 'coding_attempts_total', { outcome: 'pass' }), 1);
      assert.equal(await sample(m, 'worker_inference_seconds_count', { outcome: 'ok' }), 1);
      assert.equal(await sample(m, 'verification_duration_seconds_count', { outcome: 'pass' }), 1);
      assertValidExposition(await m.render());

    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function assertValidExposition(text: string): void {
  assert.ok(text.endsWith('\n'));
  const metricLine = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="[^"\\\n]*"(,|(?=\})))*\})? (-?\d+(\.\d+)?([eE][+-]?\d+)?|NaN|[+-]?Inf)$/;
  for (const line of text.trimEnd().split('\n')) {
    if (line === '' || line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
    assert.match(line, metricLine, `invalid exposition line: ${line}`);
  }
}
