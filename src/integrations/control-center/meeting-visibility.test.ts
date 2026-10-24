import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { CapacityLease } from '../../runtime/capacity/model-capacity.ts';
import { CollaborationStore } from '../../runtime/collaboration/store.ts';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { makeRepo, plan, tempDir, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { ProviderRegistry, type ProviderEntry } from '../../workers/providers/registry.ts';
import { LifecycleStore } from '../../lead/lifecycle/store.ts';
import { directoryOf, runMeetingCommand, sidecarPath, type MeetingCommandDeps, type MeetingSidecar } from '../../lead/collaboration/meeting-cli.ts';
import { ENGINEERING_LEAD_ID } from '../../lead/collaboration/roster.ts';
import { createCollaborationReader } from './collaboration-adapter.ts';

/**
 * M12 collaboration visibility: an ordinary engineering meeting about real scheduler work is persisted in the scheduler of
 * record with VERIFIED references, replays from a fresh connection, and is shown attributed by the read-only collaboration API.
 * Deterministic: Ollama is a fake fetch; nothing here is a Council record.
 */

const MODEL = 'qwen3:8b-ctx8192';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
};

const ollamaEntry = (): ProviderEntry => ({
  id: 'ollama',
  describe: () => ({ identity: { id: 'ollama', kind: 'local', model: MODEL }, capabilities: { taskTypes: ['go'], editsFiles: 'via-runtime-tools', fileScope: 'tool-enforced', cancellation: 'abort-signal', usage: 'tokens', billing: 'local-free' }, capacity: { resource: 'ollama', defaultPermits: 1 } }),
  probe: async () => ({ state: 'available', detail: `${MODEL} is installed` }),
  create: () => {
    throw new Error('a meeting never creates a coding worker');
  },
});

/** The participant's one reply: a proposal citing the escalated task. */
const fakeOllama = (taskId: string) => {
  let calls = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: MODEL }] }));
    calls++;
    const body = JSON.parse(String(init?.body));
    const reply = { kind: 'proposal', body: 'Stubs must not carry placeholder comments; review rejects any removed comment line.', evidence: [{ kind: 'task', ref: taskId }] };
    return new Response(JSON.stringify({ model: body.model, message: { content: JSON.stringify(reply) }, prompt_eval_count: 300, eval_count: 40, done_reason: 'stop' }));
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
};

const capacity = () => ({ acquire: async (holder: string): Promise<CapacityLease> => ({ id: holder, renew: () => true, lost: false, release: () => {} }) });

function setup() {
  const dir = tempDir('meeting-visibility-');
  const dbPath = join(dir, 'scheduler.db');
  const store = new SchedulerStore(dbPath);
  // Real scheduler work the meeting is about: a batch with a task, and its objective lifecycle.
  store.createBatch(plan(makeRepo(), [workerTask('obj1.t1-entry')], { batchId: 'obj1' }));
  new LifecycleStore(store).create({ objectiveId: 'obj1', batchId: 'obj1', baseCommit: 'base', actor: 'lead', oracle: { dir: '/oracle', files: {}, commands: [['true']], negativeControl: { mode: 'required' }, specHash: 'spec', pinnedAt: 1, pinnedBy: 'lead' } });
  const ollama = fakeOllama('obj1.t1-entry');
  const lines: string[] = [];
  const errors: string[] = [];
  const signals = new EventEmitter();
  const deps: MeetingCommandDeps = {
    store,
    meetingsDir: join(dir, 'meetings'),
    registry: new ProviderRegistry().register(ollamaEntry()),
    env: { AGENTIC_ALLOW_PROVIDERS: '' },
    fetchImpl: ollama.fetchImpl,
    capacity,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    inboxPollMs: 5,
    signalSource: signals,
  };
  const open = (id: string, refs: string[]) =>
    runMeetingCommand(['open', id, '--title', 'Escalation: comment_removed on obj1.t1-entry', '--agenda', 'Why was correct code rejected?', '--operator', 'anvh2', '--lead-model', 'claude-opus-5-5', '--participant', `reviewer-qwen=ollama:${MODEL}@reviewer`, '--rounds', '2', ...refs], deps);
  const sidecar = (id: string) => JSON.parse(readFileSync(sidecarPath(deps.meetingsDir, id), 'utf8')) as MeetingSidecar;
  const collabOn = (s: SchedulerStore, id: string) => new CollaborationStore(s, directoryOf(sidecar(id), 'claude-opus-5-5'));
  return { dir, dbPath, store, deps, errors, signals, open, sidecar, collabOn, ollama, cmd: (...argv: string[]) => runMeetingCommand(argv, deps) };
}

const collabRows = (dbPath: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'collab_events'").get() as { n: number }).n ? (db.prepare('SELECT count(*) AS n FROM collab_events').get() as { n: number }).n : 0;
  } finally {
    db.close();
  }
};

describe('M12 collaboration visibility: a real meeting about scheduler work', () => {
  it('is persisted with verified references, replays from a fresh connection, and is shown ATTRIBUTED by the read-only API', async () => {
    const h = setup();
    assert.equal(await h.open('m-esc', ['--objective', 'obj1', '--task', 'obj1.t1-entry']), 0);
    const running = h.cmd('run', 'm-esc');
    let settled = false;
    void running.finally(() => { settled = true; }).catch(() => {});
    try {
      await waitFor(() => h.collabOn(h.store, 'm-esc').session('m-esc').session.pending?.participant === ENGINEERING_LEAD_ID, "the Lead's turn");
      assert.equal(await h.cmd('record', 'm-esc', '--kind', 'proposal', '--body', 'The plan told the worker to replace a placeholder comment.', '--evidence', 'task:obj1.t1-entry'), 0);
      await waitFor(() => h.collabOn(h.store, 'm-esc').session('m-esc').session.pending?.round === 2, "the Lead's round-2 turn");
      const ids = h.collabOn(h.store, 'm-esc').thread('t-m-esc').messages.filter((m) => m.kind === 'proposal').map((m) => m.id);
      writeFileSync(join(h.dir, 'decision.json'), JSON.stringify({ outcome: 'accept', proposalIds: ids, rationale: 'Placeholder-free stubs; the gate stays as it is.', actionItems: [] }));
      assert.equal(await h.cmd('record', 'm-esc', '--kind', 'decision', '--body', 'Re-plan on placeholder-free stubs.', '--decision-file', join(h.dir, 'decision.json')), 0);
      assert.equal(await running, 0);
    } finally {
      // A failure above must not leave the meeting run waiting on the Lead's inbox: suspend it the way an operator would.
      if (!settled) { h.signals.emit('SIGINT'); await running.catch(() => {}); }
    }
    assert.equal(h.ollama.calls(), 1, 'one real participant call');

    // Persisted with references the scheduler verified: the objective contributed its batch.
    const live = h.collabOn(h.store, 'm-esc').thread('t-m-esc');
    assert.deepEqual(live.thread.refs, { objectiveId: 'obj1', batchId: 'obj1', taskId: 'obj1.t1-entry' });
    assert.deepEqual(live.messages.map((m) => [m.author.id, m.kind]), [[ENGINEERING_LEAD_ID, 'proposal'], ['reviewer-qwen', 'proposal'], [ENGINEERING_LEAD_ID, 'decision']]);
    h.store.close();

    // Replayable: a fresh connection rebuilds the same thread and record from the hash-chained events.
    const reopened = new SchedulerStore(h.dbPath);
    const replay = h.collabOn(reopened, 'm-esc');
    assert.deepEqual(replay.thread('t-m-esc').messages.map((m) => m.id), live.messages.map((m) => m.id));
    assert.equal(replay.record('m-esc')?.outcome, 'decided');
    reopened.close();

    // Visible in the read-only API, attributed through the verified batch, and not a Council record.
    const snapshot = createCollaborationReader({ dbPath: h.dbPath, schedulerOfRecord: true }).snapshot();
    assert.equal(snapshot.availability, 'AVAILABLE');
    const thread = snapshot.threads.find((t) => t.id === 't-m-esc')!;
    assert.deepEqual(thread.attribution, { status: 'ATTRIBUTED', batchId: 'obj1', project: 'proj', reason: null });
    assert.deepEqual([thread.objectiveId, thread.taskId, thread.synthetic], ['obj1', 'obj1.t1-entry', false]);
    const meeting = snapshot.meetings.find((m) => m.id === 'm-esc')!;
    assert.equal(meeting.outcome, 'decided');
    assert.equal(meeting.attribution?.status, 'ATTRIBUTED');
    assert.equal(meeting.decisions.length, 1);
    assert.ok(!snapshot.threads.some((t) => t.id.startsWith('council-')), 'Council records live in their own store');
  });

  it('a meeting with no reference stays UNATTRIBUTED; nothing is inferred', async () => {
    const h = setup();
    assert.equal(await h.open('m-free', []), 0);
    assert.deepEqual(h.collabOn(h.store, 'm-free').thread('t-m-free').thread.refs, {});
    const thread = createCollaborationReader({ dbPath: h.dbPath, schedulerOfRecord: true }).snapshot().threads.find((t) => t.id === 't-m-free')!;
    assert.equal(thread.attribution.status, 'UNATTRIBUTED');
    h.store.close();
  });

  it('a reference that does not resolve refuses the meeting before anything is written', async () => {
    for (const refs of [['--objective', 'nope'], ['--objective', 'obj1', '--batch', 'other'], ['--task', 'missing'], ['--batch', 'missing']]) {
      const h = setup();
      try {
        assert.equal(await h.open('m-bad', refs), 2, refs.join(' '));
        assert.match(h.errors.join('\n'), /lead meeting open: (objective|batch|task) /, refs.join(' '));
        assert.equal(collabRows(h.dbPath), 0, `${refs.join(' ')}: no collaboration event`);
        assert.equal(existsSync(sidecarPath(h.deps.meetingsDir, 'm-bad')), false, `${refs.join(' ')}: no sidecar`);
        assert.equal(h.ollama.calls(), 0);
      } finally {
        h.store.close();
      }
    }
  });
});
