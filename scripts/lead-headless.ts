/**
 * Experimental M11 headless launcher. No alternate execution path:
 * the existing pinned-oracle lifecycle owns task delegation/review/integration.
 * No automatic lock stealing, provider approval, merge or deployment.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceMission, createMission, initState, missionMetrics, pendingMission, readState, writeState } from '../src/lead/headless/state.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sub = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const required = (name: string): string => {
  const v = flag(name);
  if (!v || v.startsWith('--')) throw new Error(name + ' is required');
  return v;
};
const schedRoot = process.env.AGENTIC_SCHED_ROOT;
if (!schedRoot || resolve(schedRoot) === join(root, '.workdir'))
  throw new Error('set AGENTIC_SCHED_ROOT to a separate isolated work directory');

const workdir = resolve(schedRoot);
function inside(path: string): boolean {
  const rel = relative(workdir, resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
for (const name of ['AGENTIC_SCHED_DB','AGENTIC_MODEL_LOCK_DB','AGENTIC_ARTIFACT_ROOT']) {
  const value = process.env[name];
  if (!value || !inside(value)) throw new Error(name + ' must be explicitly inside isolated AGENTIC_SCHED_ROOT');
}
if (process.env.AGENTIC_ALLOW_PROVIDERS?.trim())
  throw new Error('headless preview prohibits provider opt-in; clear AGENTIC_ALLOW_PROVIDERS');

const missionDir = join(workdir, 'headless');
const stateFile = join(missionDir, 'mission.json');
const gate = join(missionDir, 'active-run');
const ownerFile = join(gate, 'owner.json');
const stopFile = join(missionDir, 'stop-requested');
const pauseFile = join(missionDir, 'pause-requested');
const logFile = join(missionDir, 'run.log');
const leadFile = join(root, 'scripts', 'lead.ts');
const hasFlag = async (file: string) => access(file).then(() => true, () => false);
const stopped = () => hasFlag(stopFile);
const paused = () => hasFlag(pauseFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = async (): Promise<{ token: string; pid: number | null }> =>
  JSON.parse(await readFile(ownerFile, 'utf8')) as { token: string; pid: number | null };
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const assertOwner = async (token: string) => {
  const held = await owner();
  if (held.token !== token || held.pid !== process.pid) throw new Error('supervisor ownership lost; preserving gate and execution state');
};
/** File presence, not PID liveness, determines ownership: malformed/orphan gate fails closed. */
async function gateStatus(): Promise<{ status: 'FREE' | 'HELD' | 'ORPHAN_OR_CORRUPT'; owner?: { token: string; pid: number | null } }> {
  if (!(await hasFlag(gate))) return { status: 'FREE' };
  const held = await owner().catch(() => null);
  return held && typeof held.token === 'string' && typeof held.pid === 'number' ?
    { status: 'HELD', owner: held } : { status: 'ORPHAN_OR_CORRUPT' };
}

async function start() {
  const state = await readState(stateFile);
  if (await stopped() || await paused()) throw new Error('mission stopped/paused; use resume after reconciliation');
  if (state.jobs.some((j) => j.phase === 'RUNNING' || j.phase === 'UNKNOWN'))
    throw new Error('uncertain prior execution; inspect lifecycle and reconcile first');
  if (!pendingMission(state)) return output({ status: 'NO_PENDING', mission: state.mission });
  await mkdir(gate); // atomic non-expiring exclusion. Orphan gates are never stolen.
  const token = randomUUID();
  await writeFile(ownerFile, JSON.stringify({ token, pid: null }), { flag: 'wx', mode: 0o600 });
  const log = openSync(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning',
      fileURLToPath(import.meta.url), 'worker', '--token', token], {
      cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env, AGENTIC_ALLOW_PROVIDERS: '' },
    });
  } finally { closeSync(log); }
  if (!child.pid) throw new Error('could not launch supervisor; gate kept for investigation');
  await writeFile(ownerFile, JSON.stringify({ token, pid: child.pid }));
  child.unref();
  output({ status: 'STARTED', pid: child.pid, log: logFile });
}

async function worker() {
  const token = required('--token');
  let current: Awaited<ReturnType<typeof owner>> | null = null;
  for (let i = 0; i < 30; i++) {
    current = await owner().catch(() => null);
    if (current?.token === token && current.pid === process.pid) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (current?.token !== token || current.pid !== process.pid) throw new Error('worker ownership mismatch');
  let interrupted = false;
  process.on('SIGTERM', () => { interrupted = true; });
  process.on('SIGINT', () => { interrupted = true; });
  while (!interrupted && !(await stopped())) {
    await assertOwner(token);
    if (await paused()) { await sleep(500); continue; }
    const state = await readState(stateFile);
    const job = pendingMission(state);
    if (!job) break;
    job.phase = 'RUNNING';
    job.attempts += 1;
    job.startedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    await assertOwner(token);
    await writeState(stateFile, state);
    // Pre-existing lifecycle driver decides whether the objective is accepted.
    // No explicit provider allow-list: local Qwen is the only enabled default.
    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning', leadFile,
      'lifecycle', 'run', job.objectiveId, '--server', state.baseServer,
    ], { cwd: root, env: { ...process.env, AGENTIC_ALLOW_PROVIDERS: '' }, stdio: 'inherit' });
    const exitCode = await new Promise<number | null>((done) => {
      child.once('error', () => done(null));
      child.once('exit', (code) => done(code));
    });
    await assertOwner(token);
    await writeState(stateFile, advanceMission(await readState(stateFile), job.objectiveId, exitCode));
    if (exitCode !== 0) break; // never retry an uncertain or rejected result
  }
  await assertOwner(token);
  await rm(ownerFile);
  await rmdir(gate); // remove only an empty gate; never recursively destroy an unknown successor
}

async function main() {
  switch (sub) {
    case 'init': {
      const config = JSON.parse(await readFile(resolve(required('--manifest')), 'utf8')) as {
        mission: string; server: string; objectives: string[];
      };
      await initState(stateFile, createMission(config));
      output({ status: 'INITIALIZED', stateFile }); break;
    }
    case 'start': await start(); break;
    case 'worker': await worker(); break;
    case 'status': {
      const state = await readState(stateFile);
      const gateInfo = await gateStatus();
      output({ mission: state.mission, server: state.baseServer, jobs: state.jobs,
        metrics: missionMetrics(state), stopRequested: await stopped(), pauseRequested: await paused(),
        supervisorState: gateInfo.status === 'FREE' ? 'STOPPED' : (await paused() ? 'PAUSE_REQUESTED' : 'RUNNING_OR_ORPHANED'),
        gate: gateInfo.status, owner: gateInfo.owner ?? null,
        note: gateInfo.status !== 'FREE' ? 'A PID is not identity proof. After crash reconcile the owner and child runs before manual gate cleanup.' : undefined });
      break;
    }
    case 'pause':
      await readState(stateFile);
      if ((await gateStatus()).status === 'FREE') throw new Error('supervisor not running; use stop/start instead');
      await writeFile(pauseFile, new Date().toISOString(), { flag: 'w', mode: 0o600 });
      output({ pauseRequested: true, warning: 'Cooperative pause after current objective; not a cancellation' });
      break;
    case 'stop':
      await readState(stateFile);
      await writeFile(stopFile, new Date().toISOString(), { flag: 'w', mode: 0o600 });
      output({ stopRequested: true, warning: 'Cooperative pause after current objective; no in-flight run is confirmed stopped' });
      break;
    case 'resume': {
      const gateInfo = await gateStatus();
      if (gateInfo.status === 'ORPHAN_OR_CORRUPT') throw new Error('corrupt gate; manual reconcile required');
      const state = await readState(stateFile);
      if (state.jobs.some((j) => j.phase === 'RUNNING' || j.phase === 'UNKNOWN'))
        throw new Error('unknown in-flight objective: reconcile before resuming');
      if (gateInfo.status === 'HELD') {
        if (!(await paused()) || await stopped()) throw new Error('gate held and not safely paused; manual reconcile required');
        await rm(pauseFile);
        output({ resumeRequested: true, warning: 'Pause flag cleared. Process liveness NOT confirmed; check status and logs.' });
      } else {
        await rm(stopFile, { force: true });
        await rm(pauseFile, { force: true });
        await start();
      }
      break;
    }
    default: throw new Error('usage: lead:headless init --manifest <file> | start | status | stop | pause | resume');
  }
}
main().catch((error) => { console.error('headless: ' + (error as Error).message); process.exitCode = 1; });
