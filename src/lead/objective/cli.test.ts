import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { draftOf, lead, makeFixture, objectiveFor, worker, type Fixture } from './__testing__/fixture.ts';
import { runObjectiveCommand } from './cli.ts';
import { ClaudeEngineeringLead } from './claude-lead.ts';
import { SchedulerStore } from '../../runtime/scheduler/store.ts';

let fx: Fixture;
before(async () => {
  fx = await makeFixture();
});
after(() => fx.cleanup());

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t), cwd: fx.root, workdir: fx.workdir };
  return { out, err, io, text: () => out.join('\n'), errText: () => err.join('\n') };
}

describe('lead objective', () => {
  it('first run researches and waits for the Lead; second run validates the draft; nothing executes', async () => {
    // a relative repository path resolves against the objective file
    const objectivePath = join(fx.root, 'objective.json');
    await writeFile(objectivePath, JSON.stringify({ ...objectiveFor(fx), repository: './repo' }));

    const first = harness();
    assert.equal(await runObjectiveCommand([objectivePath], first.io), 3, first.errText());
    assert.match(first.text(), /Research @/);
    assert.match(first.text(), /Relevant files/);
    assert.match(first.text(), /plan draft to .*draft\.json/);
    assert.match(first.text(), /Nothing was executed/);
    assert.equal(existsSync(join(fx.workdir, 'objectives', 'rate-limit', 'research.json')), true);
    assert.equal(existsSync(join(fx.workdir, 'objectives', 'rate-limit', 'plan.json')), false);

    const draft = draftOf([worker('limiter'), worker('policy'), lead('wire', { dependsOn: ['limiter', 'policy'] })]);
    await writeFile(join(fx.workdir, 'objectives', 'rate-limit', 'draft.json'), JSON.stringify(draft));
    const second = harness();
    assert.equal(await runObjectiveCommand([objectivePath], second.io), 0, second.errText());
    assert.match(second.text(), /Readiness: executable/);
    assert.match(second.text(), /level 0:\n\s+limiter  \[local worker\]/);
    assert.match(second.text(), /wire  \[Claude lead\].*<- limiter, policy/);
    assert.match(second.text(), /npm run lead -- objective --submit rate-limit/);
    assert.equal(existsSync(join(fx.workdir, 'scheduler')), false);

    const shown = harness();
    assert.equal(await runObjectiveCommand(['--show', 'rate-limit'], shown.io), 0);
    assert.match(shown.text(), /Readiness: executable/);

    // explicit submit queues the batch (and executes nothing); a second submit is refused
    const store = new SchedulerStore(':memory:');
    try {
      const submit = harness();
      assert.equal(await runObjectiveCommand(['--submit', 'rate-limit'], { ...submit.io, sink: store }), 0, submit.errText());
      assert.match(submit.text(), /Submitted rate-limit: 3 task\(s\); READY: rate-limit\.limiter, rate-limit\.policy/);
      assert.match(submit.text(), /rate-limit\.wire is kept by the Lead/);
      assert.match(submit.text(), /Nothing has been executed/);
      assert.equal(store.listTasks({}).length, 3);
      assert.equal(await runObjectiveCommand(['--submit', 'rate-limit'], { ...harness().io, sink: store }), 2);
    } finally {
      store.close();
    }
  });

  it('--submit reports STALE_PLAN with exit 4 and queues nothing', async () => {
    const objectivePath = join(fx.root, 'objective-stale.json');
    await writeFile(objectivePath, JSON.stringify(objectiveFor(fx, { id: 'stale-cli' })));
    const draftPath = join(fx.root, 'stale-draft.json');
    await writeFile(draftPath, JSON.stringify(draftOf([worker('a')])));
    assert.equal(await runObjectiveCommand([objectivePath, '--draft', draftPath], harness().io), 0);
    await writeFile(join(fx.repo, 'NEWFILE.md'), 'x\n');
    fx.git('add', 'NEWFILE.md');
    fx.git('commit', '-qm', 'move head');
    const store = new SchedulerStore(':memory:');
    try {
      const h = harness();
      assert.equal(await runObjectiveCommand(['--submit', 'stale-cli'], { ...h.io, sink: store }), 4);
      assert.match(h.errText(), /STALE_PLAN/);
      assert.deepEqual(store.listTasks({}), []);
    } finally {
      store.close();
    }
  });

  it('exits 1 with every error for an invalid draft and leaves no batch', async () => {
    const objectivePath = join(fx.root, 'objective-bad.json');
    await writeFile(objectivePath, JSON.stringify(objectiveFor(fx, { id: 'bad-plan' })));
    const draftPath = join(fx.root, 'bad-draft.json');
    await writeFile(draftPath, JSON.stringify(draftOf([worker('a', { dependsOn: ['b'] }), worker('b', { dependsOn: ['a'] }), worker('u', { verificationCommands: [['sh', '-c', 'x']] })])));
    const h = harness();
    assert.equal(await runObjectiveCommand([objectivePath, '--draft', draftPath], h.io), 1);
    assert.match(h.text(), /ERROR dependency_cycle/);
    assert.match(h.text(), /ERROR unsafe_verification \[u\]/);
    assert.match(h.errText(), /nothing was written for the scheduler/);
    assert.equal(existsSync(join(fx.workdir, 'objectives', 'bad-plan', 'batch.json')), false);
    const shown = harness();
    assert.equal(await runObjectiveCommand(['--show', 'bad-plan'], shown.io), 1);
  });

  it('reports a pending human decision without a batch', async () => {
    const objectivePath = join(fx.root, 'objective-human.json');
    await writeFile(objectivePath, JSON.stringify(objectiveFor(fx, { id: 'human' })));
    const draftPath = join(fx.root, 'human-draft.json');
    const decision = lead('pick', { executionOwner: 'HUMAN_DECISION', allowedFiles: [], acceptanceCriteria: [], decision: { question: 'Per key or per IP?', options: ['key', 'ip'] } });
    await writeFile(draftPath, JSON.stringify(draftOf([decision])));
    const h = harness();
    assert.equal(await runObjectiveCommand([objectivePath, '--draft', draftPath], h.io), 0);
    assert.match(h.text(), /Readiness: needs_human_decision/);
    assert.match(h.text(), /decide: Per key or per IP\? \(key \| ip\)/);
    assert.match(h.text(), /no batch was produced/);
  });

  it('--lead claude is a billed call: it needs a per-call cap, prints the worst case, has no automatic revisions, and still requires explicit submit', async () => {
    const objectivePath = join(fx.root, 'objective-claude.json');
    await writeFile(objectivePath, JSON.stringify(objectiveFor(fx, { id: 'via-claude' })));
    const bad = harness();
    assert.equal(await runObjectiveCommand([objectivePath, '--lead', 'claude'], bad.io), 2);
    assert.match(bad.errText(), /billed call: pass --max-budget-usd/);
    assert.equal(await runObjectiveCommand([objectivePath, '--lead', 'claude', '--max-budget-usd', '0'], harness().io), 2);
    assert.equal(await runObjectiveCommand([objectivePath, '--lead', 'claude', '--max-budget-usd', '50'], harness().io), 2);
    assert.equal(await runObjectiveCommand([objectivePath, '--lead', 'claude', '--max-budget-usd', '1', '--max-revisions', '9'], harness().io), 2);
    assert.equal(await runObjectiveCommand([objectivePath, '--max-budget-usd', '1'], harness().io), 2, 'a budget without a billed lead is a mistake');
    assert.equal(await runObjectiveCommand([objectivePath, '--lead', 'gpt'], harness().io), 2);

    // default: ONE call. A rejected plan is not retried at the user's expense.
    let calls = 0;
    const replies = [draftOf([worker('a', { dependsOn: ['ghost'] })]), draftOf([worker('a')])];
    const h = harness();
    const io = { ...h.io, leadFor: (_: string, kind: string) => (assert.equal(kind, 'claude'), new ClaudeEngineeringLead({ complete: async () => (calls++, JSON.stringify(replies.shift())) })) };
    assert.equal(await runObjectiveCommand([objectivePath, '--lead', 'claude', '--max-budget-usd', '1'], io), 1);
    assert.equal(calls, 1);
    assert.match(h.text(), /BILLED: at most 1 Claude call\(s\), each capped at \$1 .*worst case \$1\.00/);

    // revisions are an explicit, bounded opt-in
    const replies2 = [draftOf([worker('a', { dependsOn: ['ghost'] })]), draftOf([worker('a'), lead('l', { dependsOn: ['a'] })])];
    const h2 = harness();
    const io2 = { ...h2.io, leadFor: () => new ClaudeEngineeringLead({ complete: async () => (calls++, JSON.stringify(replies2.shift())) }) };
    assert.equal(await runObjectiveCommand([objectivePath, '--lead', 'claude', '--max-budget-usd', '0.5', '--max-revisions', '1'], io2), 0, h2.errText());
    assert.equal(calls, 3);
    assert.match(h2.text(), /at most 2 Claude call\(s\).*worst case \$1\.00/);
    assert.match(h2.text(), /after 1 revision\(s\)/);
    assert.equal(existsSync(join(fx.workdir, 'scheduler')), false);
  });

  it('usage and input errors exit 2', async () => {
    const none = harness();
    assert.equal(await runObjectiveCommand([], none.io), 2);
    assert.match(none.errText(), /usage:/);
    const missing = harness();
    assert.equal(await runObjectiveCommand([join(fx.root, 'nope.json')], missing.io), 2);
    const malformed = join(fx.root, 'malformed.json');
    await writeFile(malformed, JSON.stringify({ id: 'x' }));
    const m = harness();
    assert.equal(await runObjectiveCommand([malformed], m.io), 2);
    assert.match(m.errText(), /invalid input/);
    const unknown = harness();
    assert.equal(await runObjectiveCommand(['--show', 'never-planned'], unknown.io), 2);
  });
});
