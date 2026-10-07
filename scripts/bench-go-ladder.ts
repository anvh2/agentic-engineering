// Go difficulty-ladder benchmark for the local coding worker (qwen3 via Ollama).
// Usage: npm run bench:go -- [runsPerLevel=10] [levels=L1,L2,L3,L4,L5]
// Every run builds a fresh fixture, streams a human-readable trace, and persists artifacts under
// .workdir/go-bench/<timestamp>/<level>/run-NN/ (trace.jsonl, contract.json, attempts.json, final.diff, summary.json).
// No prompt/config changes happen between runs. PASS/FAIL is decided only by the harness verifier.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codingWorkerGo } from '../src/mastra/agents/coding-worker.ts';
import { asStreamingWorker } from '../src/mastra/agents/streaming-worker.ts';
import { resolveEditMode } from '../src/mastra/agents/coding-worker.ts';
import { runCodingTask } from '../src/mastra/workflows/coding-task-runner.ts';
import { createTraceSink } from '../src/mastra/workflows/coding-task-trace.ts';
import { LEVELS, buildFixture, type Level } from '../src/bench/go-ladder.ts';
import { aggregate, aggregateByLevel, summarizeRun, type Metrics, type RunSummary } from '../src/bench/metrics.ts';
import { persistRun } from '../src/mastra/workflows/coding-task-artifacts.ts';

const runsPerLevel = Number(process.argv[2]) || 10;
const levels = (process.argv[3]?.split(',') ?? [...LEVELS]) as Level[];
const model = process.env.OLLAMA_MODEL ?? 'qwen3:8b';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outRoot = process.env.BENCH_ARTIFACT_DIR ?? join('.workdir', 'go-bench', stamp);

console.log(`model=${model} url=${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'} editMode=${resolveEditMode()}`);
console.log(`levels=${levels.join(',')} runsPerLevel=${runsPerLevel} artifacts=${outRoot}`);

const summaries: RunSummary[] = [];
for (const level of levels) {
  for (let i = 1; i <= runsPerLevel; i += 1) {
    const runDir = join(outRoot, level, `run-${String(i).padStart(2, '0')}`);
    await mkdir(runDir, { recursive: true });
    const fx = await buildFixture(level, { parent: process.env.TMPDIR });
    console.log(`\n=== ${level} run ${i}/${runsPerLevel} ===`);
    try {
      const trace = createTraceSink({ jsonlPath: join(runDir, 'trace.jsonl'), print: (l) => console.log(l) });
      const result = await runCodingTask(fx.task, {
        repoRoot: fx.root,
        worker: asStreamingWorker(codingWorkerGo),
        modelLabel: model,
        maxAttempts: 3,
        modelTimeoutMs: 600_000,
        trace,
      });
      const summary = summarizeRun(level, result);
      await persistRun(runDir, summary, fx.task, result);
      summaries.push(summary);
    } finally {
      await fx.cleanup();
    }
  }
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const row = (name: string, m: Metrics) =>
  `| ${name} | ${m.runs} | ${pct(m.first_attempt_pass_rate)} | ${pct(m.eventual_pass_rate)} | ${pct(m.verification_failure_rate)} | ${pct(m.runtime_failure_rate)} | ${pct(m.forbidden_mutation_rate)} | ${m.average_attempts_to_pass?.toFixed(2) ?? '-'} | ${(m.average_latency_ms / 1000).toFixed(0)}s | ${m.runtime_retries_total} | ${JSON.stringify(m.failure_classes)} | ${JSON.stringify(m.attempt_failure_classes)} |`;
const table = [
  '| level | runs | first-attempt pass | eventual pass | verif. failure rate (attempts) | runtime failure rate | forbidden mut. | avg attempts to pass | avg latency | runtime retries | final failure classes | failed-attempt classes |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...Object.entries(aggregateByLevel(summaries)).map(([l, m]) => row(l, m)),
  row('ALL', aggregate(summaries)),
].join('\n');
console.log(`\n${table}`);
await writeFile(join(outRoot, 'summary.md'), `${table}\n`);
await writeFile(join(outRoot, 'summary.json'), JSON.stringify({ model, editMode: resolveEditMode(), runsPerLevel, byLevel: aggregateByLevel(summaries), overall: aggregate(summaries), runs: summaries }, null, 2));
console.log(`\nartifacts: ${outRoot}`);
