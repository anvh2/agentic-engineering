// Recovery / failure injection through the REAL scheduler (lead-sched), real Mastra executor, real qwen3:8b,
// on throwaway repositories, a disposable server (:4112), disposable scheduler DBs and a disposable capacity DB.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const S = '/private/tmp/claude-501/-Users-anvh-go-src-github-com-anvh2-harness-engineering/2bdedb7a-d117-4b74-b975-8735395f3272/scratchpad';
const COPY = join(S, 'audit');
const E = join(S, 'e2e', 'recovery');
const ART = join(E, 'artifacts');
const CAP_DB = join(E, 'model-capacity.db');
const PORT = 4112;
const SERVER = `http://127.0.0.1:${PORT}`;
const API = `${SERVER}/api/workflows/coding-task-workflow`;
const LADDER = join(COPY, 'src/bench/go-ladder');
const results: Record<string, unknown>[] = [];
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();

// ---- server -------------------------------------------------------------------------------------------------
let server: ChildProcess | undefined;
async function startServer() {
  server = spawn('npm', ['run', 'dev'], { cwd: COPY, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), HARNESS_ARTIFACT_ROOT: ART, HARNESS_MODEL_LOCK_DB: CAP_DB } });
  for (const s of [server.stdout!, server.stderr!]) s.on('data', (d) => writeFileSync(join(E, 'server.log'), d, { flag: 'a' }));
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${API}/runs?perPage=1`)).ok) return; } catch { /* booting */ }
    await sleep(1000);
  }
  throw new Error('server did not come up');
}
function killServer() { if (server?.pid) try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }

// ---- repos / plans ------------------------------------------------------------------------------------------
const TASKS: Record<string, { level: string; pkg: string }> = { calc: { level: 'L1', pkg: './internal/calculator/...' }, slug: { level: 'L2', pkg: './slug/...' } };
function makeRepo(name: string, keys: string[]): string {
  const dir = join(E, 'repos', name);
  mkdirSync(dir, { recursive: true });
  for (const k of keys) cpSync(join(LADDER, TASKS[k].level, 'stub'), dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'stubs');
  return dir;
}
function taskSpec(id: string, key: string) {
  const t = JSON.parse(readFileSync(join(LADDER, TASKS[key].level, 'task.json'), 'utf8'));
  return {
    id, title: t.objective.slice(0, 60), priority: 50, executor: 'worker',
    request: { contract: { ...t, taskId: id, verificationCommands: [['go', 'test', '-count=1', TASKS[key].pkg]] }, assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function with tests' } },
  };
}
function sched(name: string) {
  const root = join(E, 'sched', name);
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, HARNESS_SCHED_ROOT: root, HARNESS_SCHED_DB: join(root, 's.db'), MASTRA_URL: SERVER };
  const args = (cmd: string[]) => ['--disable-warning=ExperimentalWarning', join(COPY, 'scripts/lead-sched.ts'), ...cmd];
  return {
    root,
    db: join(root, 's.db'),
    run: (...cmd: string[]) => execFileSync(process.execPath, args(cmd), { cwd: COPY, env, encoding: 'utf8' }),
    spawn: (...cmd: string[]) => {
      const p = spawn(process.execPath, args(cmd), { cwd: COPY, env, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout!.on('data', (d) => writeFileSync(join(root, 'lead-sched.log'), d, { flag: 'a' }));
      p.stderr!.on('data', (d) => writeFileSync(join(root, 'lead-sched.log'), d, { flag: 'a' }));
      return p;
    },
  };
}
function plan(s: ReturnType<typeof sched>, batchId: string, repo: string, tasks: object[]) {
  const file = join(s.root, 'plan.json');
  writeFileSync(file, JSON.stringify({ batchId, project: 'recovery-e2e', repository: repo, tasks, integrationCommands: [['go', 'vet', './...']] }));
  log(s.run('plan', file).split('\n')[0]);
}
const task = (s: ReturnType<typeof sched>, id: string) => {
  const db = new DatabaseSync(s.db, { readOnly: true });
  try { return db.prepare('SELECT id, state, failure_category, state_reason, run_id, run_ids, claims, worktree_path FROM tasks WHERE id = ?').get(id) as Record<string, any>; } finally { db.close(); }
};
const executions = (taskId: string) => (existsSync(ART) ? readdirSync(ART).filter((d) => d.startsWith(`${taskId}-`)) : []);
async function waitModelStarted(taskId: string) {
  for (let i = 0; i < 600; i++) {
    for (const d of executions(taskId)) { const f = join(ART, d, 'trace.jsonl'); if (existsSync(f) && readFileSync(f, 'utf8').includes('"model_started"')) return; }
    await sleep(500);
  }
  throw new Error(`model never started for ${taskId}`);
}
async function runStatus(runId: string) { try { return (await (await fetch(`${API}/runs/${runId}`)).json()) as { status?: string; result?: { status?: string; reasons?: string[] } }; } catch { return {}; } }
async function waitRunTerminal(runId: string, ms = 20 * 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await runStatus(runId); if (s.status && !['running', 'pending', 'waiting'].includes(s.status)) return s; await sleep(2000); }
  throw new Error(`run ${runId} did not finish`);
}
const exited = (p: ChildProcess) => new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', (c) => r(c))));
function record(scenario: string, data: Record<string, unknown>) { log(scenario, JSON.stringify(data)); results.push({ scenario, ...data }); writeFileSync(join(E, 'recovery-results.json'), JSON.stringify(results, null, 2)); }

// ---- scenarios ----------------------------------------------------------------------------------------------
async function scenarioA() {
  const s = sched('A');
  const repo = makeRepo('A', ['calc', 'slug']);
  plan(s, 'A', repo, [taskSpec('A-calc', 'calc'), taskSpec('A-slug', 'slug')]);
  const t0 = new Date();
  log(s.run('run', '--batch', 'A', '--server', SERVER, '--workers', '2', '--ollama', '2').split('\n').filter((l) => /claimed|review|RUNTIME|ESCALATED/.test(l)).join(' | '));
  const states = ['A-calc', 'A-slug'].map((id) => task(s, id));
  const approved: string[] = [];
  for (const t of states) if (t.state === 'REVIEW_PENDING') { s.run('review', 'decide', t.id, 'approve', '--feedback', 'e2e'); approved.push(t.id); }
  let integrate = '';
  if (approved.length) { try { integrate = s.run('integrate', 'A'); } catch (err) { integrate = String((err as { stdout?: string }).stdout ?? err); } }
  record('A-concurrency-capacity-integration', { startedAt: t0.toISOString(), states: ['A-calc', 'A-slug'].map((id) => ({ id, ...pick(task(s, id)) })), integrate: integrate.trim().split('\n'), userBranchUntouched: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git(repo, 'status', '--porcelain') === '' });
}
async function scenarioB() {
  const s = sched('B');
  const repo = makeRepo('B', ['calc']);
  plan(s, 'B', repo, [taskSpec('B-calc', 'calc')]);
  const p = s.spawn('run', '--batch', 'B', '--server', SERVER, '--lease-ms', '20000');
  await waitModelStarted('B-calc');
  await sleep(3000);
  p.kill('SIGKILL'); // scheduler crashes while the Mastra run keeps going on the server
  await exited(p);
  const lost = task(s, 'B-calc');
  log('scheduler killed; task is', lost.state, 'run', lost.run_id);
  const finished = await waitRunTerminal(lost.run_id);
  log('orphaned-by-client run finished on the server:', finished.result?.status);
  await sleep(21_000); // lease (20s) expires
  const out = s.run('resume', '--run', '--batch', 'B', '--server', SERVER);
  const t = task(s, 'B-calc');
  record('B-scheduler-crash-adopt', { stateBeforeResume: lost.state, serverRunResult: finished.result?.status, after: pick(t), runIdsAfter: JSON.parse(t.run_ids), workerStepExecutions: executions('B-calc').length, adoptedLog: /adopted outcome/.test(out) });
}
async function scenarioC() {
  const s = sched('C');
  const repo = makeRepo('C', ['calc']);
  plan(s, 'C', repo, [taskSpec('C-calc', 'calc')]);
  const p = s.spawn('run', '--batch', 'C', '--server', SERVER);
  await waitModelStarted('C-calc');
  await sleep(3000);
  killServer(); // the Mastra server dies mid model call; the scheduler keeps polling
  await sleep(3000);
  await startServer(); // boot re-drives the run -> run-once guard refuses it
  const code = await exited(p);
  const failed = task(s, 'C-calc');
  const firstRun = failed.run_id;
  const firstRunStatus = await runStatus(firstRun);
  const execAfterRestart = executions('C-calc').length;
  s.run('retry', 'C-calc');
  s.run('run', '--batch', 'C', '--server', SERVER);
  const t = task(s, 'C-calc');
  record('C-server-crash-guard-retry', { schedulerExit: code, afterRestart: pick(failed), firstRunResult: firstRunStatus.result?.status, firstRunReason: firstRunStatus.result?.reasons?.[0]?.slice(0, 90), executionsAfterRestart: execAfterRestart, afterRetry: pick(t), runIds: JSON.parse(t.run_ids), totalExecutions: executions('C-calc').length });
}
async function scenarioD() {
  const s = sched('D');
  const repo = makeRepo('D', ['calc']);
  plan(s, 'D', repo, [taskSpec('D-calc', 'calc')]);
  s.run('run', '--batch', 'D', '--server', SERVER, '--task-timeout-ms', '15000');
  const timedOut = task(s, 'D-calc');
  const run = await runStatus(timedOut.run_id);
  await sleep(10_000); // the aborted step restores the tree
  const worktreeClean = timedOut.worktree_path ? git(timedOut.worktree_path, 'status', '--porcelain') === '' : null;
  s.run('retry', 'D-calc');
  s.run('run', '--batch', 'D', '--server', SERVER);
  const t = task(s, 'D-calc');
  record('D-timeout-cancel-retry', { afterTimeout: pick(timedOut), timedOutRunStatus: run.status, worktreeCleanAfterCancel: worktreeClean, afterRetry: pick(t), runIds: JSON.parse(t.run_ids), totalExecutions: executions('D-calc').length });
}
function pick(t: Record<string, any>) { return { state: t.state, category: t.failure_category, reason: (t.state_reason ?? '').slice(0, 100), claims: t.claims }; }

mkdirSync(ART, { recursive: true });
await startServer();
log('server up');
try {
  for (const [name, fn] of [['A', scenarioA], ['B', scenarioB], ['C', scenarioC], ['D', scenarioD]] as const) {
    try { await fn(); } catch (err) { record(name, { error: (err as Error).message }); }
  }
} finally {
  killServer();
}
