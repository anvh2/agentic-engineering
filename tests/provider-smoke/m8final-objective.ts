import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllowList } from '../../src/runtime/execution/worker-provider.ts';
import { M85_LIMITS, judge as judgeM85, preflightProblems as basePreflightProblems, type ObjectiveDefinition } from './m85-objective.ts';
import type { CodexConfig } from '../../src/workers/providers/codex.ts';

/**
 * M8 final: the first REAL objective with business value. A small reusable Go component, `affiliate-video-economics`, in TWO dependent
 * coding tasks run through the same machinery as M8.5/M8.6 (pinned objective -> scheduler -> dedicated Mastra HTTP server -> Codex worker ->
 * runtime verifier -> verified review -> integrateBatch -> pinned independent oracle). The runner itself is `runM85Objective` with this definition.
 *
 *   A  m8f-accounting  accounting/accounting.go   integer-money cost accounting of generation attempts
 *   B  m8f-budget      budget/budget.go           budget evaluation of A's Summary against the USD 0.50 ceiling
 *
 * The fixture files live in ./m8final: `stubs/` (what the worker starts from), `task-tests/` (runtime-owned, hidden from the worker),
 * `oracle/` (the independent acceptance test, pinned by hash before the first claim) and `reference/` (a solution used ONLY to prove the
 * oracle and the fake-CLI rehearsal; never given to a worker). The worker cannot read this directory: the isolation profile is an allow-list
 * and this directory is denied explicitly on top of it.
 */

export const M8F_OPT_IN_ENV = 'AGENTIC_REAL_PROVIDER_SMOKE';
export const M8F_OPT_IN_VALUE = 'codex-m8-final';
export const M8F_OBJECTIVE_ID = 'm8f-video-economics';
export const M8F_TASK_A = 'm8f-accounting';
export const M8F_TASK_B = 'm8f-budget';
export const M8F_REQUIRED_CODEX_VERSION = '0.161.0';
export const M8F_LIMITS = { ...M85_LIMITS };

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'm8final');

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

export const STUBS = readTree(join(FIXTURE_DIR, 'stubs'));
export const REFERENCE = readTree(join(FIXTURE_DIR, 'reference'));
export const ORACLE_FILES = readTree(join(FIXTURE_DIR, 'oracle'));
export const TASK_TESTS = {
  [M8F_TASK_A]: { path: 'accounting/accounting_task_test.go', content: readFileSync(join(FIXTURE_DIR, 'task-tests/accounting/accounting_task_test.go'), 'utf8') },
  [M8F_TASK_B]: { path: 'budget/budget_task_test.go', content: readFileSync(join(FIXTURE_DIR, 'task-tests/budget/budget_task_test.go'), 'utf8') },
} as const;

export const ACCEPTANCE_CRITERIA = [
  'Objective m8f-video-economics (Go module example.com/videoeconomics), two dependent tasks:',
  '  A  m8f-accounting  accounting/accounting.go  Ledger.Record and Ledger.Summary over the pre-supplied accounting/types.go (Amount known/unknown, Ratio, Summary).',
  '  B  m8f-budget      budget/budget.go          Evaluate / EvaluateForecast of A\'s Summary against the USD 0.50 ceiling, over the pre-supplied budget/types.go; B requires A integrated.',
  'Business constraints (targets, NOT observed prices): hard ceiling USD 0.50 per accepted video; preferred range USD 0.25-0.35.',
  'Accepted only if ALL hold:',
  '  1. both tasks reach DONE through verified review and integrateBatch, A before B, on lead-integration/m8f-video-economics;',
  '  2. the pinned oracle (acceptance_test.go; go vet ./... ; go test -count=1 ./...) PASSES on the integration tip;',
  '  3. the same oracle FAILS (real exit code) on the batch base (negative control);',
  '  4. oracle files hash exactly as pinned, pinned before the first claim; tip and base identities match the repository;',
  '  5. <= 2 Codex invocations (<= 1 per task), 1 claim per task, no repair, no fallback, no push, main untouched.',
].join('\n');

const MONEY_RULES = 'All money is an integer number of micro-USD (1 USD = 1_000_000); floating point is forbidden everywhere in the production code: no float32 or float64 type and no floating-point literal.';

export const PLAN_TASKS = (provider: string) =>
  [
    {
      id: M8F_TASK_A,
      title: 'Implement Ledger.Record and Ledger.Summary',
      priority: 60,
      executor: 'worker',
      maxClaims: M8F_LIMITS.maxClaimsPerTask,
      dependsOn: [],
      request: {
        contract: {
          taskId: M8F_TASK_A,
          objective: [
            'Implement Ledger.Record and Ledger.Summary in accounting/accounting.go: replace both panic("TODO") bodies with a working implementation. You may add unexported helpers. Do not change or remove any existing exported name, type, field, signature, constant or comment.',
            'accounting/types.go is already complete and is part of the specification (do NOT edit it): it defines Amount (Known, Unknown, Micros), Ratio, Outcome, Attempt, Config, the Ledger struct with its private fields (attempts, perVideo, accepted) and NewLedger, the error variables and the Summary struct whose field comments define every number. Read it first and use its fields.',
            MONEY_RULES,
            'Ledger.Record checks in this order and records nothing when it fails: (1) empty VideoID or an Outcome other than Accepted/Rejected -> ErrInvalidAttempt; (2) the video already has an Accepted attempt -> ErrVideoAlreadyAccepted; (3) MaxAttemptsPerVideo != 0 and the video already has that many recorded attempts -> ErrRetryCeiling. Otherwise the attempt is recorded (an Accepted attempt may be the last allowed one).',
            'Ledger.Summary computes every Summary field as documented from the recorded attempts. Unknown components contribute nothing to the sums and are never treated as zero: an attempt with at least one unknown component counts once in UnknownCostAttempts, and CostComplete is UnknownCostAttempts == 0.',
            'RejectedSpendMicros sums the known components of the attempts whose Outcome is Rejected, including attempts of videos that were accepted later. AcceptedVideos counts videos with an Accepted attempt; Videos counts distinct VideoIDs.',
            'The three ratios are unreduced: CostPerAccepted = Ratio{KnownSpendMicros, AcceptedVideos}, AcceptanceRate = Ratio{AcceptedVideos, Videos}, AttemptsPerAccepted = Ratio{Attempts, AcceptedVideos}. When the denominator is zero the Den is 0 (undefined). An empty Ledger gives zero numbers, CostComplete true and undefined ratios.',
            'Keep the change compact (about 50 lines): the review gate flags changes of more than 80 changed lines and a rewrite of existing lines. Use the standard library only. Do not invent prices or statistics.',
          ].join(' '),
          allowedFiles: ['accounting/accounting.go'],
          contextFiles: ['accounting/types.go'],
          acceptanceCriteria: [
            'a video rejected twice then accepted: 3 attempts, 1 accepted video, spend of all three attempts counted, CostPerAccepted = total spend / 1',
            'a video that is never accepted still adds its spend; with zero accepted videos the cost per accepted ratio is undefined',
            'a missing cost component is counted in UnknownCostAttempts and is not treated as zero',
            'the retry ceiling and acceptance rules of Record, and Ratio.RoundHalfUp, behave as specified',
          ],
          verificationCommands: [['go', 'test', '-count=1', './...']],
          constraints: ['tests are immutable', 'standard library only', 'no floating point anywhere in the production code', 'do not modify any other file'],
          hiddenFiles: { [TASK_TESTS[M8F_TASK_A].path]: TASK_TESTS[M8F_TASK_A].content },
        },
        assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one package with a fully specified API; every rule is written out' },
        provider,
      },
    },
    {
      id: M8F_TASK_B,
      title: 'Implement Evaluate and EvaluateForecast',
      priority: 50,
      executor: 'worker',
      maxClaims: M8F_LIMITS.maxClaimsPerTask,
      dependsOn: [M8F_TASK_A],
      request: {
        contract: {
          taskId: M8F_TASK_B,
          objective: [
            'Implement Evaluate and EvaluateForecast in budget/budget.go (replace the panic("TODO") bodies; you may add unexported helpers). Do not change or remove any existing exported name, type, field, signature, constant or comment.',
            'budget/types.go is already complete and is part of the specification (do NOT edit it): it defines the business constants, Verdict, Basis, PreferredRange, the reason codes, Policy, Result and newResult. newResult(basis, p) validates the policy (ErrInvalidPolicy) and returns a Result with Basis, Pipeline, the effective CeilingMicros and MinAcceptedVideos, HardCeilingMicros and an empty non-nil ReasonCodes: call it first in both functions. accounting/types.go and accounting/accounting.go (the previous task, already in your worktree) define accounting.Summary and accounting.Ratio: use them, never re-declare or duplicate them in package budget.',
            MONEY_RULES,
            'EvaluateForecast fails with ErrInvalidForecast for a negative forecast.',
            'Evaluate(s, p) copies s unchanged into Result.Summary and sets CostPerAccepted = accounting.Ratio{Num: s.KnownSpendMicros, Den: int64(s.AcceptedVideos)}.',
            'Let acc = int64(s.AcceptedVideos) and known = s.KnownSpendMicros. Compare EXACTLY with integer multiplication (known versus ceiling*acc), never with a rounded or divided average. The verdict is decided by the first matching rule: (1) acc == 0 -> InsufficientEvidence with ReasonCodes [ReasonNoAcceptedVideos]; (2) acc < the effective minimum sample (Result.MinAcceptedVideos) -> InsufficientEvidence with [ReasonBelowMinSample]; (3) known > Result.CeilingMicros*acc -> OverBudget with [ReasonAboveCeiling] (this holds even when s.CostComplete is false, because the known spend is then a lower bound); (4) !s.CostComplete -> InsufficientEvidence with [ReasonCostIncomplete]; (5) otherwise WithinTarget with no reason codes. Spend exactly equal to the ceiling is WithinTarget.',
            'OverHardCeiling is true when acc > 0 and known > HardCeilingMicros*acc (a lower bound counts), otherwise false.',
            'PreferredRange (reported separately from the verdict, exact integer comparison, both ends of [PreferredLowMicros, PreferredHighMicros] inclusive): RangeUnknown when acc == 0; RangeAbove when known > PreferredHighMicros*acc (even if the cost is incomplete); RangeUnknown when the cost is incomplete; RangeBelow when known < PreferredLowMicros*acc; RangeInside otherwise.',
            'EvaluateForecast(f, p) returns Basis Forecast (via newResult), a zero Summary, CostPerAccepted = Ratio{f, 1}, OverHardCeiling = f > HardCeilingMicros, the PreferredRange rules applied to f directly (below PreferredLowMicros, above PreferredHighMicros, otherwise inside), and verdict OverBudget with [ReasonAboveCeiling] when f > Result.CeilingMicros and WithinTarget otherwise. The minimum sample is not applied to a forecast. It never presents a forecast as measured.',
            'Keep the change compact (about 60 lines): the review gate flags changes of more than 80 changed lines. Use the standard library only. Do not invent prices or statistics.',
          ].join(' '),
          allowedFiles: ['budget/budget.go'],
          contextFiles: ['accounting/types.go', 'accounting/accounting.go', 'budget/types.go'],
          acceptanceCriteria: [
            'a measured summary of one accepted video costing 300000 micros is WithinTarget, inside the preferred range, Basis Measured',
            'spend above the ceiling is OverBudget; zero accepted videos or unknown costs are InsufficientEvidence and never WithinTarget',
            'operator ceilings above HardCeilingMicros are rejected with ErrInvalidPolicy',
            'budget imports and uses the accounting package',
          ],
          verificationCommands: [['go', 'test', '-count=1', './...']],
          constraints: ['tests are immutable', 'standard library only', 'no floating point anywhere in the production code', 'do not modify any other file, in particular not accounting/accounting.go'],
          hiddenFiles: { [TASK_TESTS[M8F_TASK_B].path]: TASK_TESTS[M8F_TASK_B].content },
        },
        assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one decision function over the previous task output; every rule is written out' },
        provider,
      },
    },
  ] as never[];

export const ECONOMICS: ObjectiveDefinition = {
  id: M8F_OBJECTIVE_ID,
  project: 'videoeconomics',
  description: 'M8 final real objective: affiliate-video-economics',
  taskIds: [M8F_TASK_A, M8F_TASK_B],
  stubs: STUBS,
  taskTests: TASK_TESTS,
  oracleFiles: ORACLE_FILES,
  oracleCommands: [['go', 'vet', './...'], ['go', 'test', '-count=1', './...']],
  criteria: ACCEPTANCE_CRITERIA,
  planTasks: PLAN_TASKS,
  integrationCommands: [['go', 'vet', './...']],
  // the whole fixture directory (oracle, reference solution, task tests) and this file (which names them) are unreadable to workers and to worker-written code
  secretPaths: [FIXTURE_DIR, fileURLToPath(import.meta.url)],
  outDirNames: { isolated: 'm8-final-real', plain: 'm8-final-plain' },
  gitIdentity: 'm8f',
};

// ---------------------------------------------------------------------------------------------------------------- the gate

export type M8FAuthorization = { ok: true; allowProviders: string[]; model: string } | { ok: false; reason: string };

/**
 * Disabled unless the operator opts in, takes no arguments, requires an EXPLICIT model pin (no CLI default is ever used) and narrows the
 * operator's allow-list to exactly these two tasks.
 */
export function checkM8FAuthorization(env: NodeJS.ProcessEnv, argv: readonly string[] = []): M8FAuthorization {
  if (env[M8F_OPT_IN_ENV] !== M8F_OPT_IN_VALUE) return { ok: false, reason: `the real M8 final objective is disabled by default; it calls a cloud model and spends the operator's Codex quota. Opt in with ${M8F_OPT_IN_ENV}=${M8F_OPT_IN_VALUE}` };
  if (argv.length > 0) return { ok: false, reason: `this command takes no arguments (${argv.join(' ')}): it runs one fixed disposable objective` };
  const model = env.AGENTIC_CODEX_MODEL?.trim();
  if (!model) return { ok: false, reason: 'AGENTIC_CODEX_MODEL must name the approved model; the CLI default is never used for this experiment' };
  const allow = parseAllowList(env.AGENTIC_ALLOW_PROVIDERS);
  const entries = [`codex:${M8F_TASK_A}`, `codex:${M8F_TASK_B}`];
  if (!allow.includes('codex') && !entries.every((e) => allow.includes(e))) return { ok: false, reason: `no operator authorization: set AGENTIC_ALLOW_PROVIDERS=${entries.join(',')} (entries seen: ${allow.join(', ') || 'none'})` };
  return { ok: true, allowProviders: entries, model };
}

// ---------------------------------------------------------------------------------------------------------------- preflight

/** Free, local, no model call: everything that must hold before the first Codex invocation. Returns the problems found (empty = go). */
export async function m8fPreflightProblems(options: { codex?: CodexConfig; projectRoot: string; env?: NodeJS.ProcessEnv }): Promise<string[]> {
  return [...(await basePreflightProblems({ codex: options.codex })), ...m8fStaticProblems(options)];
}

/** The light part of the preflight: Codex version, an explicit model, the project location and the fixture's content. No sandbox is started. */
export function m8fStaticProblems(options: { codex?: CodexConfig; projectRoot: string }): string[] {
  const problems: string[] = [];
  const command = options.codex?.command ?? 'codex';
  try {
    const version = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
    if (!version.includes(M8F_REQUIRED_CODEX_VERSION)) problems.push(`codex CLI version is "${version}", this experiment is approved for ${M8F_REQUIRED_CODEX_VERSION} only`);
  } catch (err) {
    problems.push(`cannot run \`${command} --version\`: ${(err as Error).message.slice(0, 120)}`);
  }
  if (!options.codex?.model) problems.push('no model pinned (AGENTIC_CODEX_MODEL)');
  if (/^\/(private\/)?tmp(\/|$)/.test(options.projectRoot)) problems.push(`the project lives under /tmp (${options.projectRoot}); the fixture must be kept outside /private/tmp`);
  // the fixture handed to a worker must hold no secret: scan the stubs for credential shapes
  const credentialShape = /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,})/i;
  for (const [path, content] of Object.entries({ ...STUBS, ...Object.fromEntries(Object.entries(TASK_TESTS).map(([, t]) => [t.path, t.content])) })) {
    if (credentialShape.test(content)) problems.push(`fixture file ${path} looks like it contains a credential`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------- verdict

export type M8FVerdict = 'M8_REAL_OBJECTIVE_ACCEPTED' | 'M8_REAL_OBJECTIVE_FAILED' | 'M8_REAL_OBJECTIVE_INCONCLUSIVE';

/** The same evidence-based judgement as M8.5 (every acceptance and safety condition, each from evidence), under this milestone's verdict names. */
export function judge(report: Record<string, any>): { verdict: M8FVerdict; why: string[] } {
  const j = judgeM85(report);
  return { verdict: j.verdict.replace('M8_5_', 'M8_') as M8FVerdict, why: j.why };
}
