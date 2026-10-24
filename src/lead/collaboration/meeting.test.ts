import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CapacityLease } from '../../runtime/capacity/model-capacity.ts';
import { CollaborationStore } from '../../runtime/collaboration/store.ts';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';
import { makeRepo, plan, tempDir, workerTask } from '../../runtime/scheduler/test-helpers.ts';
import { LifecycleStore } from '../lifecycle/store.ts';
import { geminiEntry } from '../../workers/providers/gemini.ts';
import { ProviderRegistry, type ProviderEntry } from '../../workers/providers/registry.ts';
import { directoryOf, runMeetingCommand, sidecarPath, verifiedRefs, type MeetingCommandDeps, type MeetingSidecar } from './meeting-cli.ts';
import { buildTurnPrompt, parseModelReply } from './meeting-participants.ts';
import { ENGINEERING_LEAD_ID } from './roster.ts';
import { decideSuggestion, listSuggestions, suggestForDeadTasks } from './suggestions.ts';

/** Deterministic: no network, no model, no paid provider. Ollama is a fake fetch; Gemini is the fake CLI under its real adapter. */

const MODEL = 'qwen3:8b-ctx8192';
const FAKE_GEMINI = fileURLToPath(new URL('../../workers/providers/__testing__/fake-gemini.mjs', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(10);
  }
};

const ollamaDescriptorEntry = (): ProviderEntry => ({
  id: 'ollama',
  describe: () => ({ identity: { id: 'ollama', kind: 'local', model: MODEL }, capabilities: { taskTypes: ['go'], editsFiles: 'via-runtime-tools', fileScope: 'tool-enforced', cancellation: 'abort-signal', usage: 'tokens', billing: 'local-free' }, capacity: { resource: 'ollama', defaultPermits: 1 } }),
  probe: async () => ({ state: 'available', detail: `${MODEL} is installed` }),
  create: () => {
    throw new Error('the meeting must not create the ollama coding worker');
  },
});
const cloudEntry = (id: string): ProviderEntry => ({
  id,
  describe: () => ({ identity: { id, kind: 'cloud', model: 'UNKNOWN' }, capabilities: { taskTypes: ['go'], editsFiles: 'directly', fileScope: 'os-sandbox', cancellation: 'process-group', usage: 'tokens', billing: 'unknown' }, capacity: { resource: id, defaultPermits: 1 } }),
  probe: async () => {
    throw new Error(`${id} must not even be probed without authorization`);
  },
  create: () => {
    throw new Error(`${id} must not be created without authorization`);
  },
});

interface FakeOllama {
  fetchImpl: typeof fetch;
  calls: { body: any; aborted: () => boolean }[];
}
/** Replies in order; a reply may be a function of the request, a delay, or an error status. */
function fakeOllama(replies: ({ text: string; delayMs?: number; model?: string; status?: number } | ((body: any) => { text: string }))[]): FakeOllama {
  const calls: FakeOllama['calls'] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: MODEL }] }));
    const body = JSON.parse(String(init?.body));
    const signal = init?.signal as AbortSignal | undefined;
    calls.push({ body, aborted: () => signal?.aborted === true });
    const r = replies[calls.length - 1];
    if (!r) throw new Error(`unexpected model call #${calls.length}`);
    const reply = typeof r === 'function' ? r(body) : r;
    const { delayMs = 0, model = body.model, status = 200 } = reply as { delayMs?: number; model?: string; status?: number };
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason);
      }, { once: true });
    });
    if (status !== 200) return new Response('boom', { status });
    return new Response(JSON.stringify({ model, message: { content: reply.text }, prompt_eval_count: 400, eval_count: 60, done_reason: 'stop' }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface FakeCapacity {
  acquired: string[];
  released: number;
  loseNext?: boolean;
  acquire(holder: string): Promise<CapacityLease>;
}
function fakeCapacity(): FakeCapacity {
  const c: FakeCapacity = {
    acquired: [],
    released: 0,
    async acquire(holder) {
      c.acquired.push(holder);
      const lost = c.loseNext === true;
      c.loseNext = false;
      return { id: holder, renew: () => !lost, lost, release: () => void (c.released += 1) };
    },
  };
  return c;
}

function env(extra: { registry?: ProviderRegistry; ollama?: FakeOllama; allow?: string } = {}) {
  const dir = tempDir('meeting-');
  const store = new SchedulerStore(join(dir, 'scheduler.db'));
  const capacity = fakeCapacity();
  const lines: string[] = [];
  const errs: string[] = [];
  const signals = new EventEmitter();
  const deps: MeetingCommandDeps = {
    store,
    meetingsDir: join(dir, 'meetings'),
    registry: extra.registry ?? new ProviderRegistry().register(ollamaDescriptorEntry()).register(cloudEntry('gemini')).register(cloudEntry('codex')),
    env: { AGENTIC_ALLOW_PROVIDERS: extra.allow ?? '' },
    fetchImpl: extra.ollama?.fetchImpl,
    capacity: () => capacity,
    signalSource: signals,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    inboxPollMs: 5,
  };
  writeFileSync(join(dir, 'agenda.txt'), 'What causes the timeout?\nWhat is the smallest fix?\n');
  writeFileSync(join(dir, 'briefing.md'), 'Evidence: F1 test race, F2 engagedBy ignores the resource.\n');
  const open = (id: string, more: string[] = []) => runMeetingCommand(['open', id, '--title', 'Timeout incident', '--agenda-file', join(dir, 'agenda.txt'), '--briefing', join(dir, 'briefing.md'), '--operator', 'anvh2', '--lead-model', 'claude-opus-5-5', '--participant', `reviewer-qwen=ollama:${MODEL}@reviewer`, ...more], deps);
  const cmd = (...argv: string[]) => runMeetingCommand(argv, deps);
  const sidecar = (id: string) => JSON.parse(readFileSync(sidecarPath(deps.meetingsDir, id), 'utf8')) as MeetingSidecar;
  const collab = (id: string) => new CollaborationStore(store, directoryOf(sidecar(id), 'claude-opus-5-5'));
  const lastJson = () => JSON.parse(lines[lines.length - 1]);
  return { dir, store, deps, capacity, lines, errs, signals, open, cmd, sidecar, collab, lastJson };
}

describe('M10 lead meeting: authorization (deterministic)', () => {
  it('refuses to open a meeting with an unauthorized paid provider, names the exact approval and writes nothing', async () => {
    const e = env({ ollama: fakeOllama([]) });
    const code = await e.open('m-auth', ['--participant', 'challenger-gemini=gemini:gemini-3.5-flash-lite@reviewer']);
    assert.equal(code, 3);
    assert.ok(e.errs.some((l) => l.includes('provider_not_authorized') && l.includes('gemini:meeting-m-auth')), e.errs.join('\n'));
    assert.equal(existsSync(sidecarPath(e.deps.meetingsDir, 'm-auth')), false);
    assert.equal((e.store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'collab_events'").get() as { n: number }).n, 0, 'the collaboration tables were not even created');
  });

  it('--exclude-unauthorized opens without them and records who was excluded and why, in the thread', async () => {
    const e = env({ ollama: fakeOllama([]) });
    assert.equal(await e.open('m-excl', ['--participant', 'challenger-gemini=gemini:gemini-3.5-flash-lite@reviewer', '--participant', 'reviewer-codex=codex:UNKNOWN@reviewer', '--exclude-unauthorized']), 0);
    const s = e.sidecar('m-excl');
    assert.deepEqual(s.participants.map((p) => p.id), [ENGINEERING_LEAD_ID, 'reviewer-qwen']);
    assert.deepEqual(s.excluded.map((x) => x.id), ['challenger-gemini', 'reviewer-codex']);
    const comments = e.collab('m-excl').thread(s.threadId).messages.map((m) => m.body);
    assert.ok(comments.some((b) => b.includes('challenger-gemini') && b.includes('gemini:meeting-m-excl')));
    assert.ok(comments.some((b) => b.includes('reviewer-codex') && b.includes('codex:meeting-m-excl')));
  });

  it('a run re-checks authorization: revoking it stops the next turn before any call', async () => {
    const e = env({ ollama: fakeOllama([]), allow: 'gemini:meeting-m-rev' });
    // the cloud entry refuses probe/create; give gemini a probe-able entry for the open
    const registry = new ProviderRegistry().register(ollamaDescriptorEntry()).register({ ...cloudEntry('gemini'), probe: async () => ({ state: 'available', detail: 'ok' }) });
    e.deps.registry = registry;
    assert.equal(await e.open('m-rev', ['--participant', 'challenger-gemini=gemini:gemini-3.5-flash-lite@reviewer']), 0);
    e.deps.env = { AGENTIC_ALLOW_PROVIDERS: '' };
    assert.equal(await e.cmd('run', 'm-rev'), 3);
    assert.ok(e.errs.some((l) => l.includes('gemini:meeting-m-rev')));
    assert.equal(e.collab('m-rev').session('m-rev').session.invocationsUsed, 0, 'no turn was reserved');
  });
});

describe('M10 lead meeting: a full model-backed meeting (deterministic)', () => {
  it('lead + local model: independent first proposals, an objection, a decision; provenance and UNKNOWN usage kept honest', async () => {
    const ollama = fakeOllama([
      (body) => {
        const user = body.messages[1].content as string;
        assert.ok(!user.includes('LEAD-ROUND-1-SECRET'), 'round 1 is blind: the Lead\'s round-1 proposal is not shown');
        assert.match(user, /1 other round-1 proposal\(s\) are hidden/);
        assert.match(user, /F2 engagedBy ignores the resource/, 'the briefing is in the prompt');
        assert.equal(body.options.num_predict, 1_200, 'per-call output ceiling');
        assert.equal(body.think, false);
        return { text: JSON.stringify({ kind: 'proposal', body: 'Scope engagedBy to the resource.', evidence: [{ kind: 'file', ref: 'src/runtime/capacity/model-capacity.ts' }] }) };
      },
    ]);
    const e = env({ ollama });
    assert.equal(await e.open('m-full', ['--rounds', '2']), 0);
    const running = e.cmd('run', 'm-full');
    // round 1, turn 0: the Lead (independently, first)
    await waitFor(() => e.collab('m-full').session('m-full').session.pending?.participant === ENGINEERING_LEAD_ID, 'the Lead\'s turn');
    assert.equal(await e.cmd('record', 'm-full', '--kind', 'proposal', '--body', 'LEAD-ROUND-1-SECRET: fix the test race.', '--evidence', 'file:tests/provider-smoke/gemini-http-smoke.test.ts'), 0);
    // round 2, turn 0: the Lead decides after the objection
    await waitFor(() => e.collab('m-full').session('m-full').session.pending?.round === 2 && e.collab('m-full').session('m-full').session.pending?.participant === ENGINEERING_LEAD_ID, 'the Lead\'s round-2 turn');
    const lead1 = e.collab('m-full').thread('t-m-full').messages.find((m) => m.author.id === ENGINEERING_LEAD_ID && m.kind === 'proposal')!;
    const qwen1 = e.collab('m-full').thread('t-m-full').messages.find((m) => m.author.id === 'reviewer-qwen' && m.kind === 'proposal')!;
    writeFileSync(join(e.dir, 'decision.json'), JSON.stringify({ outcome: 'accept', proposalIds: [lead1.id, qwen1.id], rationale: 'Both causes are real; fix both.', actionItems: [{ owner: 'reviewer-qwen', description: 'review the fix' }] }));
    assert.equal(await e.cmd('record', 'm-full', '--kind', 'decision', '--body', 'Fix both.', '--decision-file', join(e.dir, 'decision.json')), 0);
    assert.equal(await running, 0);
    const result = e.lastJson();
    assert.equal(result.outcome, 'decided');
    assert.ok(existsSync(result.record));

    const msgs = e.collab('m-full').thread('t-m-full').messages;
    assert.deepEqual(msgs.map((m) => [m.author.id, m.kind]), [
      [ENGINEERING_LEAD_ID, 'proposal'],
      ['reviewer-qwen', 'proposal'],
      [ENGINEERING_LEAD_ID, 'decision'],
    ]);
    const qwen = msgs.filter((m) => m.author.id === 'reviewer-qwen');
    assert.equal(qwen.length, 1, 'the decision ended the meeting before qwen\'s round-2 turn');
    assert.equal(qwen[0].invocation?.provider, 'ollama');
    assert.equal(qwen[0].invocation?.model, MODEL);
    assert.match(qwen[0].invocation?.runId ?? '', /^ollama-/);
    assert.deepEqual([qwen[0].invocation?.usage.inputTokens, qwen[0].invocation?.usage.outputTokens], [400, 60]);
    assert.deepEqual(qwen[0].evidence, [{ kind: 'file', ref: 'src/runtime/capacity/model-capacity.ts' }]);
    const lead = msgs.filter((m) => m.author.id === ENGINEERING_LEAD_ID);
    assert.ok(lead.every((m) => m.invocation?.provider === 'claude' && m.invocation.model === 'claude-opus-5-5'));
    assert.ok(lead.every((m) => m.invocation?.usage.inputTokens === 'UNKNOWN' && m.invocation.usage.outputTokens === 'UNKNOWN'), 'the Lead\'s usage is UNKNOWN, never 0');
    assert.equal(e.capacity.acquired.length, 1);
    assert.equal(e.capacity.released, 1, 'the capacity lease was released after the call');
    assert.match(e.capacity.acquired[0], /^ollama:qwen3:8b-ctx8192:meeting-m-full:reviewer-qwen:pid\d+$/);
    assert.equal(ollama.calls.length, 1, 'only one model call was needed');
  });

  it('an objection the model raises in round 2 is kept with its parent; the Lead cannot overwrite a recorded turn', async () => {
    const ollama = fakeOllama([
      { text: JSON.stringify({ kind: 'proposal', body: 'P-qwen' }) },
      (body) => ({ text: JSON.stringify({ kind: 'objection', parentId: /\[(m\d+)\] round 1 claude-engineering-lead/.exec(body.messages[1].content)![1], body: 'Not enough evidence.' }) }),
    ]);
    const e = env({ ollama });
    assert.equal(await e.open('m-obj', ['--rounds', '2']), 0);
    const running = e.cmd('run', 'm-obj');
    await waitFor(() => e.collab('m-obj').session('m-obj').session.pending?.participant === ENGINEERING_LEAD_ID, 'lead turn 1');
    assert.equal(await e.cmd('record', 'm-obj', '--kind', 'proposal', '--body', 'P-lead'), 0);
    assert.equal(await e.cmd('record', 'm-obj', '--kind', 'proposal', '--body', 'again'), 2, 'a second record for the same turn is refused');
    await waitFor(() => e.collab('m-obj').session('m-obj').session.pending?.round === 2, 'round 2');
    assert.equal(await e.cmd('record', 'm-obj', '--kind', 'pass', '--body', 'nothing to add'), 0);
    assert.equal(await running, 0);
    assert.equal(e.lastJson().outcome, 'unresolved', 'no decision: the record says unresolved, not consensus');
    const msgs = e.collab('m-obj').thread('t-m-obj').messages;
    const objection = msgs.find((m) => m.kind === 'objection')!;
    assert.equal(objection.author.id, 'reviewer-qwen');
    assert.equal(objection.parentId, msgs.find((m) => m.body === 'P-lead')!.id);
  });
});

describe('M10 lead meeting: limits, cancellation, fencing (deterministic)', () => {
  it('per-participant invocation ceiling: the turn fails before any call and the meeting concludes failed', async () => {
    const ollama = fakeOllama([{ text: JSON.stringify({ kind: 'proposal', body: 'one' }) }]);
    const e = env({ ollama });
    assert.equal(await e.open('m-cap', ['--rounds', '3', '--max-participant-invocations', '1']), 0);
    const running = e.cmd('run', 'm-cap');
    await waitFor(() => e.collab('m-cap').session('m-cap').session.pending?.participant === ENGINEERING_LEAD_ID, 'lead 1');
    await e.cmd('record', 'm-cap', '--kind', 'proposal', '--body', 'lead one');
    await waitFor(() => e.collab('m-cap').session('m-cap').session.pending?.round === 2, 'lead 2');
    await e.cmd('record', 'm-cap', '--kind', 'comment', '--body', 'continue');
    assert.equal(await running, 1);
    assert.equal(e.lastJson().outcome, 'failed');
    const s = e.collab('m-cap').session('m-cap').session;
    assert.match(s.outcome!.reason, /invocation ceiling reached \(1\/1\)/);
    assert.equal(ollama.calls.length, 1, 'the second call was never made');
  });

  it('a model answering with another model than the pinned one fails the turn', async () => {
    const e = env({ ollama: fakeOllama([{ text: '{}', model: 'qwen3:8b' }]) });
    assert.equal(await e.open('m-pin'), 0);
    const running = e.cmd('run', 'm-pin');
    await waitFor(() => e.collab('m-pin').session('m-pin').session.pending?.participant === ENGINEERING_LEAD_ID, 'lead');
    await e.cmd('record', 'm-pin', '--kind', 'proposal', '--body', 'x');
    assert.equal(await running, 1);
    assert.match(e.collab('m-pin').session('m-pin').session.outcome!.reason, /not the pinned qwen3:8b-ctx8192/);
  });

  it('a capacity lease lost during the call discards the reply (no unfenced post)', async () => {
    const e = env({ ollama: fakeOllama([{ text: JSON.stringify({ kind: 'proposal', body: 'late' }) }]) });
    assert.equal(await e.open('m-lost'), 0);
    e.capacity.loseNext = true;
    const running = e.cmd('run', 'm-lost');
    await waitFor(() => e.collab('m-lost').session('m-lost').session.pending?.participant === ENGINEERING_LEAD_ID, 'lead');
    await e.cmd('record', 'm-lost', '--kind', 'proposal', '--body', 'x');
    assert.equal(await running, 1);
    const msgs = e.collab('m-lost').thread('t-m-lost').messages;
    assert.ok(!msgs.some((m) => m.body === 'late'), 'the reply produced while unfenced was not posted');
    assert.equal(e.capacity.released, 1);
  });

  it('SIGINT during a model call aborts the call, suspends the session; a new run resumes and re-asks the abandoned turn', async () => {
    const ollama = fakeOllama([{ text: JSON.stringify({ kind: 'proposal', body: 'never' }), delayMs: 60_000 }, { text: JSON.stringify({ kind: 'proposal', body: 'resumed' }) }]);
    const e = env({ ollama });
    assert.equal(await e.open('m-int', ['--rounds', '1']), 0);
    const first = e.cmd('run', 'm-int');
    await waitFor(() => e.collab('m-int').session('m-int').session.pending?.participant === ENGINEERING_LEAD_ID, 'lead');
    await e.cmd('record', 'm-int', '--kind', 'proposal', '--body', 'lead');
    await waitFor(() => ollama.calls.length === 1, 'the slow call');
    e.signals.emit('SIGINT');
    assert.equal(await first, 130);
    assert.equal(ollama.calls[0].aborted(), true, 'the in-flight HTTP call was aborted');
    assert.equal(e.capacity.released, 1, 'its lease was released');
    assert.equal(e.collab('m-int').session('m-int').session.suspended, true);
    assert.equal(e.signals.listenerCount('SIGINT'), 0, 'signal handlers removed');
    assert.equal(await e.cmd('run', 'm-int'), 0);
    const s = e.collab('m-int').session('m-int').session;
    assert.equal(s.outcome!.outcome, 'unresolved');
    assert.ok(s.turns.some((t) => t.outcome === 'abandoned' && t.participant === 'reviewer-qwen'), 'the interrupted turn is recorded as abandoned');
    assert.ok(e.collab('m-int').thread('t-m-int').messages.some((m) => m.body === 'resumed'));
  });

  it('the operator cancels a waiting meeting; the running coordinator stops and the record says cancelled', async () => {
    const e = env({ ollama: fakeOllama([]) });
    assert.equal(await e.open('m-cancel'), 0);
    const running = e.cmd('run', 'm-cancel');
    await waitFor(() => e.collab('m-cancel').session('m-cancel').session.pending?.participant === ENGINEERING_LEAD_ID, 'lead');
    assert.equal(await e.cmd('cancel', 'm-cancel', '--reason', 'superseded'), 0);
    assert.equal(await e.cmd('record', 'm-cancel', '--kind', 'proposal', '--body', 'too late'), 2, 'nothing can be recorded in a cancelled meeting');
    // the run was waiting on the Lead's inbox: it notices the cancel without waiting for its 30-minute turn timeout
    const code = await running;
    assert.equal(code, 0);
    assert.equal(e.collab('m-cancel').session('m-cancel').session.status, 'cancelled');
    assert.ok(readFileSync(join(e.deps.meetingsDir, 'm-cancel', 'record.md'), 'utf8').includes('cancelled'));
  });
});

describe('M10 lead meeting: provider adapters (deterministic)', () => {
  it('a registered CLI provider answers through its real adapter in an empty scratch repo (fake Gemini CLI)', async () => {
    const reply = JSON.stringify({ kind: 'objection', parentId: 'm1', body: 'Gemini-side objection.' });
    const registry = new ProviderRegistry()
      .register(ollamaDescriptorEntry())
      .register(geminiEntry({ command: FAKE_GEMINI, model: 'gemini-3.5-flash-lite', termGraceMs: 200, env: { FAKE_MODE: 'reply', FAKE_REPLY: reply } }));
    const e = env({ registry, ollama: fakeOllama([{ text: JSON.stringify({ kind: 'proposal', body: 'qwen' }) }]), allow: 'gemini:meeting-m-gem' });
    assert.equal(await e.open('m-gem', ['--rounds', '1', '--participant', 'challenger-gemini=gemini:gemini-3.5-flash-lite@reviewer']), 0, e.errs.join('\n'));
    const running = e.cmd('run', 'm-gem');
    await waitFor(() => e.collab('m-gem').session('m-gem').session.pending?.participant === ENGINEERING_LEAD_ID, 'lead');
    await e.cmd('record', 'm-gem', '--kind', 'proposal', '--body', 'lead');
    assert.equal(await running, 0, e.errs.join('\n'));
    const g = e.collab('m-gem').thread('t-m-gem').messages.find((m) => m.author.id === 'challenger-gemini');
    assert.ok(g, JSON.stringify(e.collab('m-gem').session('m-gem').session.turns));
    assert.equal(g!.kind, 'objection');
    assert.equal(g!.parentId, 'm1');
    assert.equal(g!.invocation?.provider, 'gemini');
    assert.equal(g!.invocation?.model, 'gemini-3.5-flash-lite');
    assert.match(g!.invocation?.runId ?? '', /^gemini-/);
    assert.deepEqual([g!.invocation?.usage.inputTokens, g!.invocation?.usage.outputTokens], [120, 34]);
    assert.ok(existsSync(join(e.deps.meetingsDir, 'm-gem', 'scratch-challenger-gemini', '.git')), 'it ran in the meeting-owned scratch repository');
    assert.deepEqual(e.capacity.acquired.map((h) => h.split(':')[0]), ['ollama', 'gemini'], 'each call held its own provider capacity');
  });

  it('parseModelReply keeps the model\'s words: structured JSON, or a comment carrying the raw text', () => {
    assert.deepEqual(parseModelReply('<think>hmm</think>{"kind":"objection","parentId":"m3","body":"no"}'), { kind: 'objection', body: 'no', parentId: 'm3', evidence: undefined, parsed: true });
    assert.deepEqual(parseModelReply('{"kind":"decision","body":"I decide"}'), { kind: 'comment', body: '{"kind":"decision","body":"I decide"}', parsed: false }, 'a model cannot decide');
    assert.deepEqual(parseModelReply('plain words'), { kind: 'comment', body: 'plain words', parsed: false });
  });

  it('buildTurnPrompt hides only OTHER participants\' round-1 messages, only in round 1', () => {
    const m = (id: string, author: string, round: number) => ({ id, seq: 1, threadId: 't', sessionId: 's', round, turn: 0, at: 1, author: { id: author, role: 'reviewer', kind: 'reviewer' }, parentId: null, kind: 'proposal', body: `body-${id}`, refs: {}, evidence: [], invocation: null, decision: null, correctedBy: [], withdrawnBy: null }) as any;
    const ctx = (round: number) => ({ sessionId: 's', threadId: 't', agenda: ['a'], round, turn: 1, attempt: 1, maxRounds: 3, chair: 'lead', self: { id: 'q', role: 'reviewer', kind: 'reviewer' }, transcript: [m('m1', 'lead', 1), m('m2', 'q', 1)], budget: { invocationsUsed: 0, maxInvocations: 9, tokensUsed: 0, maxTokens: null } }) as any;
    const r1 = buildTurnPrompt(ctx(1), { blindFirstRound: true }).user;
    assert.ok(!r1.includes('body-m1') && r1.includes('body-m2'));
    assert.ok(buildTurnPrompt(ctx(2), { blindFirstRound: true }).user.includes('body-m1'));
    assert.ok(buildTurnPrompt(ctx(1), { blindFirstRound: false }).user.includes('body-m1'));
  });
});

describe('M12 lead meeting: verified references', () => {
  const tables = (s: SchedulerStore) => (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  const withWork = () => {
    const s = new SchedulerStore(join(tempDir('meeting-refs-'), 'scheduler.db'));
    s.createBatch(plan(makeRepo(), [workerTask('sub.t1')], { batchId: 'sub' }));
    s.createBatch(plan(makeRepo(), [workerTask('pin.t1')], { batchId: 'pin-batch' }));
    return s;
  };

  it('no reference is no reference: the meeting stays unattributed', () => {
    const s = withWork();
    assert.equal(verifiedRefs(s, {}), undefined);
    s.close();
  });

  it('only a pinned objective is verifiable: a batch that merely shares its id is refused, and nothing is written to check it', () => {
    const s = withWork();
    assert.ok(!tables(s).includes('objective_lifecycle'));
    // `sub` is a real batch (submitted, or created with `lead plan`), but nothing proves an objective stands behind it.
    assert.throws(() => verifiedRefs(s, { objectiveId: 'sub' }), /objective sub is not pinned .* reference a submitted objective with --batch <id>/);
    assert.throws(() => verifiedRefs(s, { objectiveId: 'planned-only' }), /objective planned-only is not pinned/);
    assert.deepEqual(verifiedRefs(s, { batchId: 'sub' }), { batchId: 'sub' }, 'the batch itself is the verifiable reference');
    assert.ok(!tables(s).includes('objective_lifecycle'), 'verification never creates lifecycle tables');
    s.close();
  });

  it('a row the scheduler quarantines as corrupt refuses the reference instead of escaping as a store error', () => {
    const s = withWork();
    s.db.prepare("UPDATE tasks SET spec = '{' WHERE id = 'sub.t1'").run();
    assert.throws(() => verifiedRefs(s, { taskId: 'sub.t1' }), (err: Error) => err.constructor.name === 'MeetingCliError' && /task sub.t1 cannot be read/.test(err.message));
    s.close();
  });

  it('a pinned objective resolves to its lifecycle batch; task and batch must agree with it', () => {
    const s = withWork();
    new LifecycleStore(s).create({ objectiveId: 'pin', batchId: 'pin-batch', baseCommit: 'b', actor: 'lead', oracle: { dir: '/o', files: {}, commands: [['true']], negativeControl: { mode: 'required' }, specHash: 'h', pinnedAt: 1, pinnedBy: 'lead' } });
    assert.deepEqual(verifiedRefs(s, { objectiveId: 'pin', taskId: 'pin.t1' }), { objectiveId: 'pin', batchId: 'pin-batch', taskId: 'pin.t1' });
    assert.throws(() => verifiedRefs(s, { objectiveId: 'pin', batchId: 'sub' }), /runs as batch pin-batch, not sub/);
    assert.throws(() => verifiedRefs(s, { objectiveId: 'pin', taskId: 'sub.t1' }), /task sub.t1 is in batch sub, not pin-batch/);
    s.close();
  });

  it('a task contributes its batch; unknown or invalid ids are refused', () => {
    const s = withWork();
    assert.deepEqual(verifiedRefs(s, { taskId: 'sub.t1' }), { batchId: 'sub', taskId: 'sub.t1' });
    assert.throws(() => verifiedRefs(s, { taskId: 'missing' }), /task missing does not exist/);
    assert.throws(() => verifiedRefs(s, { batchId: 'missing' }), /batch missing does not exist/);
    assert.throws(() => verifiedRefs(s, { batchId: 'a b' }), /is not a valid id/);
    s.close();
  });

  it('a reference flag with no value, or given twice, refuses the meeting instead of being dropped', async () => {
    for (const more of [['--task'], ['--objective', '--batch', 'x'], ['--task', 'a', '--task', 'b']]) {
      const e = env();
      assert.equal(await e.open('m-flags', more), 2, more.join(' '));
      assert.match(e.errs.join('\n'), /needs a value|is given 2 times/, more.join(' '));
      assert.equal(existsSync(sidecarPath(e.deps.meetingsDir, 'm-flags')), false);
      e.store.close();
    }
  });
});

describe('M12 lead meeting: accepting or dismissing a meeting suggestion', () => {
  /** A pinned objective whose task escalated on review: the lifecycle would have suggested exactly this. */
  const withSuggestion = (e: ReturnType<typeof env>) => {
    e.store.createBatch(plan(makeRepo(), [workerTask('obj1.pad'), workerTask('obj1.title')], { batchId: 'obj1' }));
    new LifecycleStore(e.store).create({ objectiveId: 'obj1', batchId: 'obj1', baseCommit: 'b', actor: 'lead', oracle: { dir: '/o', files: {}, commands: [['true']], negativeControl: { mode: 'required' }, specHash: 'h', pinnedAt: 1, pinnedBy: 'lead' } });
    e.store.db.prepare("UPDATE tasks SET state = 'ESCALATED', failure_category = 'review_rejected', state_reason = 'finding:comment_removed' WHERE id = 'obj1.pad'").run();
    return suggestForDeadTasks(e.store, { objectiveId: 'obj1', batchId: 'obj1', tasks: [e.store.requireTask('obj1.pad')], actor: 'lifecycle-driver' }).created[0];
  };

  it('opening a meeting with --suggestion attaches it to exactly that work and accepts the suggestion in the same transaction', async () => {
    const e = env();
    const s = withSuggestion(e);
    assert.equal(await e.cmd('suggestions', '--status', 'pending'), 0);
    assert.deepEqual(e.lastJson().suggestions.map((x: { id: string }) => x.id), [s.id]);
    assert.match(e.lastJson().note, /not meetings/);
    assert.equal(await e.open('m-sg', ['--suggestion', s.id]), 0);
    const thread = e.collab('m-sg').thread('t-m-sg');
    assert.deepEqual(thread.thread.refs, { objectiveId: 'obj1', batchId: 'obj1', taskId: 'obj1.pad' });
    assert.match(thread.messages[0].body, new RegExp(`^Opened from meeting suggestion ${s.id} \\(review_escalation\\): obj1.pad is ESCALATED`));
    const [accepted] = listSuggestions(e.store);
    assert.deepEqual([accepted.status, accepted.sessionId, accepted.decidedBy], ['accepted', 'm-sg', ENGINEERING_LEAD_ID], 'the Lead accepts by default');
    assert.equal(await e.open('m-sg2', ['--suggestion', s.id]), 2, 'a suggestion is accepted once');
    assert.match(e.errs.join('\n'), /already accepted/);
    e.store.close();
  });

  it('a reference that contradicts the suggestion refuses the meeting; nothing is written and the suggestion stays pending', async () => {
    const e = env();
    const s = withSuggestion(e);
    assert.equal(await e.open('m-x', ['--suggestion', s.id, '--task', 'obj1.title']), 2);
    assert.match(e.errs.join('\n'), /--task obj1.title contradicts suggestion/);
    assert.equal(existsSync(sidecarPath(e.deps.meetingsDir, 'm-x')), false);
    assert.equal(listSuggestions(e.store)[0].status, 'pending');
    assert.equal(await e.open('m-y', ['--suggestion', 'sg-nope']), 2);
    e.store.close();
  });

  it('an operator who accepts is recorded as the decider; someone outside the meeting cannot accept', async () => {
    const e = env();
    const s = withSuggestion(e);
    assert.equal(await e.open('m-op', ['--suggestion', s.id, '--accepted-by', 'mallory']), 2);
    assert.match(e.errs.join('\n'), /--accepted-by mallory must be/);
    assert.equal(listSuggestions(e.store)[0].status, 'pending');
    assert.equal(await e.open('m-op', ['--suggestion', s.id, '--accepted-by', 'anvh2']), 0);
    assert.equal(listSuggestions(e.store)[0].decidedBy, 'anvh2');
    e.store.close();
  });

  it('an unwritable meetings directory fails BEFORE the acceptance commits, so the same command works again afterwards', async () => {
    const e = env();
    const s = withSuggestion(e);
    writeFileSync(e.deps.meetingsDir, 'not a directory');
    let code: number | string;
    try {
      code = await e.open('m-fs', ['--suggestion', s.id]);
    } catch {
      code = 'threw';
    }
    assert.notEqual(code, 0);
    assert.equal(listSuggestions(e.store)[0].status, 'pending', 'nothing was accepted');
    assert.equal((e.store.db.prepare('SELECT COUNT(*) AS n FROM collab_events').get() as { n: number }).n, 0, 'no thread or session was written');
    rmSync(e.deps.meetingsDir);
    assert.equal(await e.open('m-fs', ['--suggestion', s.id]), 0, 'the identical command now succeeds');
    assert.deepEqual([listSuggestions(e.store)[0].status, listSuggestions(e.store)[0].sessionId], ['accepted', 'm-fs']);
    assert.equal(existsSync(`${sidecarPath(e.deps.meetingsDir, 'm-fs')}.opening`), false, 'no half-published sidecar is left');
    e.store.close();
  });

  it('a suggestion decided by someone else after the pre-check but before the commit opens nothing', async () => {
    const e = env();
    const s = withSuggestion(e);
    const racing: ProviderEntry = { ...ollamaDescriptorEntry(), probe: async () => {
      decideSuggestion(e.store, s.id, { status: 'dismissed', by: 'anvh2', reason: 'handled elsewhere' });
      return { state: 'available', detail: `${MODEL} is installed` };
    } };
    e.deps.registry = new ProviderRegistry().register(racing);
    assert.equal(await e.open('m-race', ['--suggestion', s.id]), 2);
    assert.match(e.errs.join('\n'), /already dismissed/);
    assert.equal(existsSync(sidecarPath(e.deps.meetingsDir, 'm-race')), false);
    assert.equal(existsSync(`${sidecarPath(e.deps.meetingsDir, 'm-race')}.opening`), false);
    assert.equal((e.store.db.prepare('SELECT COUNT(*) AS n FROM collab_events').get() as { n: number }).n, 0, 'the thread and session rolled back with it');
    assert.equal(listSuggestions(e.store)[0].status, 'dismissed');
    e.store.close();
  });

  it('dismissing needs who and why; a dismissed suggestion cannot be opened', async () => {
    const e = env();
    const s = withSuggestion(e);
    assert.equal(await e.cmd('dismiss-suggestion', s.id, '--by', 'anvh2'), 2);
    assert.equal(await e.cmd('dismiss-suggestion', s.id, '--by', 'any one', '--reason', 'r'), 2, 'the decider is an id');
    assert.equal(await e.cmd('dismiss-suggestion', s.id, '--by', 'anvh2', '--reason', '   '), 2);
    assert.equal(listSuggestions(e.store)[0].status, 'pending');
    assert.equal(await e.cmd('dismiss-suggestion', s.id, '--by', 'anvh2', '--reason', 'already re-planned'), 0);
    assert.deepEqual([listSuggestions(e.store)[0].status, listSuggestions(e.store)[0].decisionReason], ['dismissed', 'already re-planned']);
    assert.equal(await e.open('m-z', ['--suggestion', s.id]), 2);
    assert.match(e.errs.join('\n'), /already dismissed/);
    e.store.close();
  });
});
