// Reliability Lab runner (M10). Repeats scenarios with bounded concurrency and writes one JSON evidence record per run plus a
// summary with the classification of every failure.
//
//   node tests/reliability/run.ts --scenario <id|all> [--scenario <id> ...] [--repeat N] [--concurrency K] [--out DIR]
//   npm run reliability -- --scenario all --repeat 3 --concurrency 2
//
// Ceilings are hard: concurrency <= 4 and repeat <= 50 per scenario (the smoke scenarios each start a Mastra server child and
// a sandboxed CLI; more parallelism measures the machine, not the product). Exit code 0 iff every run passed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, EVIDENCE_SCHEMA, type Category, type Evidence } from './classify.ts';
import { SCENARIOS } from './scenarios.ts';

export const MAX_CONCURRENCY = 4;
export const MAX_REPEAT = 50;

export interface RunOptions {
  scenarios: string[];
  repeat: number;
  concurrency: number;
  outDir: string;
  log?: (line: string) => void;
}

export interface Summary {
  schema: 'agentic.reliability-summary/1';
  scenarios: string[];
  repeat: number;
  concurrency: number;
  runs: number;
  peakConcurrency: number;
  byCategory: Partial<Record<Category, number>>;
  byScenario: Record<string, Partial<Record<Category, number>>>;
  failures: { file: string; scenario: string; run: number; category: Category; reasons: string[] }[];
  startedAt: string;
  durationMs: number;
  environment: { node: string; platform: string; cpus: number; loadavg1AtStart: number };
}

export async function runScenarios(options: RunOptions): Promise<Summary> {
  const ids = options.scenarios.includes('all') ? Object.keys(SCENARIOS) : options.scenarios;
  for (const id of ids) if (!SCENARIOS[id]) throw new Error(`unknown scenario "${id}" (known: ${Object.keys(SCENARIOS).join(', ')})`);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY) throw new Error(`concurrency must be 1..${MAX_CONCURRENCY}`);
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > MAX_REPEAT) throw new Error(`repeat must be 1..${MAX_REPEAT}`);
  mkdirSync(options.outDir, { recursive: true });
  const log = options.log ?? (() => {});
  const started = Date.now();
  const environment = { node: process.version, platform: platform(), cpus: availableParallelism(), loadavg1AtStart: loadavg()[0] };

  const queue = ids.flatMap((id) => Array.from({ length: options.repeat }, (_, i) => ({ id, run: i + 1 })));
  let active = 0;
  let peak = 0;
  const results: { file: string; evidence: Evidence; category: Category; reasons: string[] }[] = [];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      active += 1;
      peak = Math.max(peak, active);
      const t0 = Date.now();
      let evidence: Evidence;
      try {
        const r = await SCENARIOS[job.id].run();
        evidence = { schema: EVIDENCE_SCHEMA, scenario: job.id, run: job.run, kind: SCENARIOS[job.id].kind, covers: SCENARIOS[job.id].covers, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, loadavg1: loadavg()[0], ...r };
      } catch (err) {
        evidence = { schema: EVIDENCE_SCHEMA, scenario: job.id, run: job.run, kind: SCENARIOS[job.id].kind, covers: SCENARIOS[job.id].covers, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, loadavg1: loadavg()[0], ok: false, failure: { message: (err as Error).message ?? String(err), stack: (err as Error).stack?.split('\n').slice(0, 8).join('\n') } };
      } finally {
        active -= 1;
      }
      const c = classify(evidence);
      const file = `${job.id}-${String(job.run).padStart(3, '0')}.json`;
      writeFileSync(join(options.outDir, file), JSON.stringify({ ...evidence, classification: c }, null, 2) + '\n');
      results.push({ file, evidence, ...c });
      log(`${file}: ${c.category}${c.reasons.length ? ` - ${c.reasons.join('; ')}` : ''} (${evidence.durationMs} ms)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));

  const byCategory: Summary['byCategory'] = {};
  const byScenario: Summary['byScenario'] = {};
  for (const r of results) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    (byScenario[r.evidence.scenario] ??= {})[r.category] = (byScenario[r.evidence.scenario][r.category] ?? 0) + 1;
  }
  const summary: Summary = {
    schema: 'agentic.reliability-summary/1',
    scenarios: ids,
    repeat: options.repeat,
    concurrency: options.concurrency,
    runs: results.length,
    peakConcurrency: peak,
    byCategory,
    byScenario,
    failures: results.filter((r) => r.category !== 'pass').map((r) => ({ file: r.file, scenario: r.evidence.scenario, run: r.evidence.run, category: r.category, reasons: r.reasons })),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    environment,
  };
  writeFileSync(join(options.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const all = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  const one = (n: string) => all(n)[0];
  const scenarios = all('--scenario');
  if (scenarios.length === 0) {
    console.error(`usage: run.ts --scenario <id|all> [--repeat N] [--concurrency K] [--out DIR]\nscenarios:\n${Object.values(SCENARIOS).map((s) => `  ${s.id.padEnd(26)} ${s.kind.padEnd(9)} ${s.covers}`).join('\n')}`);
    process.exit(2);
  }
  const outDir = one('--out') ?? join('.workdir', 'reliability', new Date().toISOString().replace(/[:.]/g, '-'));
  runScenarios({ scenarios, repeat: Number(one('--repeat') ?? 1), concurrency: Number(one('--concurrency') ?? 1), outDir, log: (l) => console.log(l) })
    .then((s) => {
      console.log(JSON.stringify({ outDir, runs: s.runs, byCategory: s.byCategory, peakConcurrency: s.peakConcurrency, durationMs: s.durationMs }, null, 2));
      process.exit(s.failures.length ? 1 : 0);
    })
    .catch((err) => {
      console.error(`reliability: ${(err as Error).message}`);
      process.exit(2);
    });
}
