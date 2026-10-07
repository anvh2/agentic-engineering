// End-to-end proof (disposable server + disposable repos + real Qwen): kill / hot reload / cancel can never cause a
// second execution of the worker step or a write after the interruption.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const S = '/private/tmp/claude-501/-Users-anvh-go-src-github-com-anvh2-harness-engineering/2bdedb7a-d117-4b74-b975-8735395f3272/scratchpad';
const COPY = join(S, 'audit');
const E2E = join(S, 'e2e');
const ART = join(E2E, 'artifacts');
const PORT = 4112;
const API = `http://127.0.0.1:${PORT}/api/workflows/coding-task-workflow`;
const LADDER = join(COPY, 'src/bench/go-ladder/L1');
const OLLAMA_LOG = `${process.env.HOME}/.ollama/logs/server.log`;
const out: Record<string, unknown>[] = [];
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | undefined;
function startServer(): Promise<void> {
  server = spawn('npm', ['run', 'dev'], {
    cwd: COPY,
    env: { ...process.env, PORT: String(PORT), HARNESS_ARTIFACT_ROOT: ART },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = join(E2E, 'server.log');
  server.stdout!.on('data', (d) => writeFileSync(sink, d, { flag: 'a' }));
  server.stderr!.on('data', (d) => writeFileSync(sink, d, { flag: 'a' }));
  return waitUp();
}
async function waitUp(): Promise<void> {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(`${API}/runs?perPage=1`)).ok) return; } catch { /* booting */ }
    await sleep(1000);
  }
  throw new Error('server did not come up');
}
function killServer(): void {
  if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }
  // the dev CLI's child (the actual server) is in the same process group
}
async function hotReload(): Promise<void> {
  const f = join(COPY, 'src/mastra/workflows/coding-task-status.ts');
  const content = readFileSync(f);
  writeFileSync(f, content); // same bytes: a change event, no code change
  await sleep(3000);
  await waitUp();
}

function makeRepo(name: string): string {
  const dir = join(E2E, 'repos', name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(LADDER, 'stub'), dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'stub');
  return dir;
}
function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (e.name === '.git') continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else h.update(p).update(readFileSync(p)); } };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}
function request(taskId: string, repository: string) {
  const t = JSON.parse(readFileSync(join(LADDER, 'task.json'), 'utf8'));
  return { contract: { ...t, taskId }, assessment: { complexity: 'small', risk: 'low', ambiguity: 'none', rationale: 'one function' }, repository };
}
async function startRun(taskId: string, repo: string): Promise<string> {
  const runId = randomUUID();
  const post = (p: string, body: unknown) => fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!(await post(`/create-run?runId=${runId}`, {})).ok) throw new Error('create-run failed');
  // /start is fire-and-forget (the harness client uses it too); /start-async would block until the run completes.
  if (!(await post(`/start?runId=${runId}`, { inputData: request(taskId, repo) })).ok) throw new Error('start failed');
  return runId;
}
async function runStatus(runId: string): Promise<{ status?: string; result?: { status?: string; reasons?: string[] } }> {
  try { return (await (await fetch(`${API}/runs/${runId}`)).json()) as never; } catch { return {}; }
}
const artifactDirs = (taskId: string) => (existsSync(ART) ? readdirSync(ART).filter((d) => d.startsWith(`${taskId}-`)) : []);
const traceEvents = (taskId: string) => artifactDirs(taskId).flatMap((d) => { const f = join(ART, d, 'trace.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => ({ dir: d, ...JSON.parse(l) })) : []; });
async function waitForModelStarted(taskId: string): Promise<void> {
  for (let i = 0; i < 300; i++) { if (traceEvents(taskId).some((e) => e.type === 'model_started')) return; await sleep(500); }
  throw new Error('model never started');
}
async function waitTerminal(runId: string, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await runStatus(runId); if (s.status && !['running', 'pending', 'waiting'].includes(s.status)) return s; await sleep(1000); }
  return runStatus(runId);
}
const ollamaChats = () => (existsSync(OLLAMA_LOG) ? readFileSync(OLLAMA_LOG, 'utf8').split('\n').filter((l) => /POST\s+"\/api\/chat"/.test(l)).length : -1);

async function scenario(name: string, interrupt: (runId: string) => Promise<void>, after?: (runId: string) => Promise<void>) {
  const taskId = `E2E-${name}`;
  const repo = makeRepo(name);
  const runId = await startRun(taskId, repo);
  log(name, 'run', runId);
  await waitForModelStarted(taskId);
  await sleep(5000); // mid model call
  const interruptedAt = new Date().toISOString();
  await interrupt(runId);
  const hashAtInterrupt = treeHash(repo);
  const chatsAtInterrupt = ollamaChats();
  if (after) await after(runId);
  const final = await waitTerminal(runId);
  await sleep(20_000); // give any zombie time to act
  const events = traceEvents(taskId);
  const late = events.filter((e) => e.ts > interruptedAt);
  const result = {
    scenario: name,
    runId,
    finalStatus: final.status,
    resultStatus: final.result?.status ?? null,
    resultReason: (final.result?.reasons ?? [])[0]?.slice(0, 120) ?? null,
    workerStepExecutions: artifactDirs(taskId).length,
    modelStartedEvents: events.filter((e) => e.type === 'model_started').length,
    traceEventsAfterInterrupt: late.map((e) => e.type),
    repoUnchangedSinceInterrupt: treeHash(repo) === hashAtInterrupt,
    repoMatchesStub: treeHash(repo) === treeHash(join(LADDER, 'stub')) || undefined,
    ollamaChatRequestsAfterInterrupt: ollamaChats() - chatsAtInterrupt,
  };
  log(JSON.stringify(result));
  out.push(result);
}

mkdirSync(ART, { recursive: true });
await startServer();
log('server up on', PORT);
try {
  await scenario('kill9', async () => { killServer(); await sleep(2000); }, async () => { await startServer(); });
  await scenario('reload', async () => { await hotReload(); });
  await scenario('cancel', async (runId) => {
    await fetch(`${API}/runs/${runId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await sleep(8000); // let the aborted step restore the tree
  }, async (runId) => {
    await hotReload(); // canceled run must not be re-driven at boot
    // and even an explicit restart of it must be refused by the run-once guard
    await fetch(`${API}/restart?runId=${runId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => log('manual restart HTTP', r.status)).catch((e) => log('manual restart error', e.message));
  });
} finally {
  writeFileSync(join(E2E, 'restart-proof.json'), JSON.stringify(out, null, 2));
  killServer();
}
