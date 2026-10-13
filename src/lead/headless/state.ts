import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type JobPhase = 'PENDING' | 'RUNNING' | 'ACCEPTED' | 'NOT_ACCEPTED' | 'ESCALATED' | 'AWAITING_OPERATOR' | 'CANCELLED' | 'UNKNOWN';
export interface Job { objectiveId: string; phase: JobPhase; attempts: number; startedAt?: string; finishedAt?: string; exitCode?: number; }
export interface MissionState { schema: 1; mission: string; baseServer: string; createdAt: string; updatedAt: string; jobs: Job[]; }
const ID = /^[A-Za-z0-9._-]{1,128}$/;

export function validateServer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port || url.port === '4111' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash) throw new Error('requires an isolated loopback HTTP server (not :4111)');
  return url.origin;
}
export function createMission(input: { mission: string; server: string; objectives: string[] }): MissionState {
  if (!ID.test(input.mission)) throw new Error('invalid mission name');
  if (input.objectives.length < 1 || input.objectives.length > 50 ||
      new Set(input.objectives).size !== input.objectives.length ||
      input.objectives.some((id) => !ID.test(id))) throw new Error('provide 1–50 unique pinned objective IDs');
  const now = new Date().toISOString();
  return { schema: 1, mission: input.mission, baseServer: validateServer(input.server),
    createdAt: now, updatedAt: now, jobs: input.objectives.map((objectiveId) => ({ objectiveId, phase: 'PENDING', attempts: 0 })) };
}
/** CLI exit code 1 is ambiguous (NOT_ACCEPTED or ordinary exception): never infer a verdict from it. */
export function classifyExit(code: number | null): JobPhase {
  switch (code) {
    case 0: return 'ACCEPTED'; case 1: return 'UNKNOWN'; case 3: return 'ESCALATED';
    case 4: return 'AWAITING_OPERATOR'; case 5: return 'CANCELLED'; default: return 'UNKNOWN';
  }
}
export function advanceMission(state: MissionState, id: string, exitCode: number | null): MissionState {
  const jobs = state.jobs.map((j) => j.objectiveId === id ? { ...j, phase: classifyExit(exitCode),
    exitCode: exitCode ?? undefined, finishedAt: new Date().toISOString() } : j);
  return { ...state, jobs, updatedAt: new Date().toISOString() };
}
/** Gemini supervisor status concept: derive metrics from persisted facts, not a second database. */
export function missionMetrics(state: MissionState): { total: number; activeTasks: string[]; processedTasks: string[]; pendingTasks: string[]; blockedTasks: string[] } {
  return {
    total: state.jobs.length,
    activeTasks: state.jobs.filter((j) => j.phase === 'RUNNING').map((j) => j.objectiveId),
    processedTasks: state.jobs.filter((j) => j.phase === 'ACCEPTED').map((j) => j.objectiveId),
    pendingTasks: state.jobs.filter((j) => j.phase === 'PENDING').map((j) => j.objectiveId),
    blockedTasks: state.jobs.filter((j) => !['PENDING','RUNNING','ACCEPTED'].includes(j.phase)).map((j) => j.objectiveId),
  };
}
export function pendingMission(state: MissionState): Job | undefined {
  return state.jobs.find((j) => j.phase === 'PENDING');
}
export async function readState(file: string): Promise<MissionState> {
  const state = JSON.parse(await readFile(file, 'utf8')) as MissionState;
  if (state.schema !== 1 || !ID.test(state.mission) || !Array.isArray(state.jobs) || state.jobs.length < 1 || state.jobs.length > 50 || new Set(state.jobs.map(j => j.objectiveId)).size !== state.jobs.length ||
      state.jobs.some((j) => !ID.test(j.objectiveId) || !Number.isInteger(j.attempts) || j.attempts < 0 || !['PENDING','RUNNING','ACCEPTED','NOT_ACCEPTED','ESCALATED','AWAITING_OPERATOR','CANCELLED','UNKNOWN'].includes(j.phase)))
    throw new Error('invalid mission state; fail closed');
  validateServer(state.baseServer);
  return state;
}
export async function writeState(file: string, state: MissionState): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(file), '.state-' + randomUUID() + '.tmp');
  const fd = await open(tmp, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(state, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
  await rename(tmp, file);
}
export async function initState(file: string, state: MissionState): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const fd = await open(file, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(state, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
}
