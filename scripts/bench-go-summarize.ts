// Aggregates persisted ladder runs: npm run bench:summarize -- <artifactDir> [<artifactDir>...]
// Reads <dir>/<level>/run-NN/summary.json (written by bench-go-ladder.ts), so a benchmark that was
// stopped early - or resumed later for other levels into another directory - can still be summarized.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregate, aggregateByLevel, type Metrics, type RunSummary } from '../tests/bench/metrics.ts';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: bench-go-summarize <artifactDir> [<artifactDir>...]');
  process.exit(2);
}

const runs: RunSummary[] = [];
for (const dir of dirs) {
  for (const level of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    for (const run of (await readdir(join(dir, level.name))).filter((n) => n.startsWith('run-')).sort()) {
      const file = join(dir, level.name, run, 'summary.json');
      try {
        runs.push(JSON.parse(await readFile(file, 'utf8')) as RunSummary);
      } catch {
        console.error(`skipping incomplete run (no summary.json): ${join(level.name, run)}`);
      }
    }
  }
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const row = (name: string, m: Metrics) =>
  `| ${name} | ${m.runs} | ${pct(m.first_attempt_pass_rate)} | ${pct(m.eventual_pass_rate)} | ${pct(m.verification_failure_rate)} | ${pct(m.runtime_failure_rate)} | ${pct(m.forbidden_mutation_rate)} | ${m.average_attempts_to_pass?.toFixed(2) ?? '-'} | ${(m.average_latency_ms / 1000).toFixed(0)}s | ${m.runtime_retries_total} | ${JSON.stringify(m.failure_classes)} | ${JSON.stringify(m.attempt_failure_classes)} |`;
console.log(
  [
    '| level | runs | first-attempt pass | eventual pass | verif. failure rate (attempts) | runtime failure rate | forbidden mut. | avg attempts to pass | avg latency | runtime retries | final failure classes | failed-attempt classes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(aggregateByLevel(runs)).map(([l, m]) => row(l, m)),
    row('ALL', aggregate(runs)),
  ].join('\n'),
);
