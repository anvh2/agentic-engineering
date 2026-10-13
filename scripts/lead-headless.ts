/**
 * Experimental M11 headless launcher. No alternate execution path:
 * the existing pinned-oracle lifecycle owns task delegation/review/integration.
 * No automatic lock stealing, provider approval, merge or deployment.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceMission, createMission, initState, pendingMission, readState, writeState } from '../src/lead/headless/state.ts';

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
const logFile = join(missionDir, 'run.log');
const leadFile = join(root, 'scripts', 'lead.ts');
const stopped = async () => access(stopFile).then(() => true, () => false);
const owner = async (): Promise<{ token: string; pid: number | null }> =>
  JSON.parse(await readFile(ownerFile, 'utf8')) as { token: string; pid: number | null };
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function start() {
  const state = await readState(stateFile);
  if (await stopped()) throw new Error('mission paused; use resume after reconciliation');
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
    const state = await readState(stateFile);
    const job = pendingMission(state);
    if (!job) break;
    job.phase = 'RUNNING';
    job.attempts += 1;
    job.startedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
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
    await writeState(stateFile, advanceMission(await readState(stateFile), job.objectiveId, exitCode));
    if (exitCode !== 0) break; // never retry an uncertain or rejected result
  }
  const held = await owner();
  if (held.token !== token || held.pid !== process.pid) throw new Error('cannot release a foreign gate');
  await rm(ownerFile);
  await rm(gate, { recursive: false });
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
      const current = await owner().catch(() => null);
      output({ ...state, stopRequested: await stopped(), gate: current ? 'HELD' : 'FREE',
        owner: current, note: current ? 'Owner may be orphaned; PID does not prove liveness' : undefined });
      break;
    }
    case 'stop':
      await readState(stateFile);
      await writeFile(stopFile, new Date().toISOString(), { flag: 'w', mode: 0o600 });
      output({ stopRequested: true, warning: 'Cooperative pause after current objective; no in-flight run is confirmed stopped' });
      break;
    case 'resume': {
      if (await owner().catch(() => null)) throw new Error('gate held/orphaned: reconcile old process and descendants manually');
      const state = await readState(stateFile);
      if (state.jobs.some((j) => j.phase === 'RUNNING' || j.phase === 'UNKNOWN'))
        throw new Error('unknown in-flight objective: reconcile before resuming');
      await rm(stopFile, { force: true });
      await start(); break;
    }
    default: throw new Error('usage: lead:headless init --manifest <file> | start | status | stop | resume');
  }
}
main().catch((error) => { console.error('headless: ' + (error as Error).message); process.exitCode = 1; });
