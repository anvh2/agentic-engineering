import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from '../../runtime/scheduler/test-helpers.ts';
import { GOOD, goRunner, harness, type Harness } from './__testing__/fixture.ts';
import { buildEngineeringContext } from '../../runtime/execution/engineering-context.ts';
import { EngineeringKnowledgeCatalog, type KnowledgeEntry } from '../../runtime/knowledge/engineering-knowledge.ts';
import { verifyReview } from './verified-review.ts';

const entry = (id: string, body = `Guidance ${id}: keep error paths explicit.`): KnowledgeEntry => ({ id, revision: 'v1', kind: 'rule', language: 'go', body, source: 'curated', approved: true });
const catalog = new EngineeringKnowledgeCatalog([entry('rule-one'), entry('rule-two')]);
const solutions = { pad: [GOOD.pad], title: [GOOD.title], describe: [GOOD.describe] };

/** A task that pinned curated knowledge before its worker ran, executed up to REVIEW_PENDING. */
async function pinnedPending(ids = ['rule-one']) {
  const h = harness({ solutions });
  const task = h.store.requireTask('pad');
  const files = task.spec.request!.contract.allowedFiles;
  const selection = catalog.resolve({ language: 'go', ids });
  const spec = task.spec;
  spec.request!.contract.knowledge = { ids, selectionDigest: selection.digest };
  h.store.db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run(JSON.stringify(spec), 'pad');
  await h.scheduler.run({ batchId: task.batchId });
  assert.equal(h.store.requireTask('pad').state, 'REVIEW_PENDING');
  const ctx = buildEngineeringContext(files, undefined, undefined, selection);
  return { h, files, ctx };
}
function record(h: Harness, ctx: { fingerprint: string }, snapshot: object | null, declared: string | undefined = ctx.fingerprint) {
  const dir = tempDir('lc-knowledge-');
  writeFileSync(join(dir, 'attempts.json'), '[]');
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'PASS', ...(declared ? { engineeringContextFingerprint: declared } : {}) }));
  if (snapshot) writeFileSync(join(dir, 'engineering-context.json'), JSON.stringify(snapshot));
  h.store.setArtifacts('pad', { artifactDir: dir });
}
const review = (h: Harness, knowledgeCatalog?: EngineeringKnowledgeCatalog) => verifyReview({ store: h.store, worktrees: h.worktrees, run: goRunner, knowledgeCatalog }, 'pad');
const check = (v: Awaited<ReturnType<typeof review>>, name: string) => v.checks.find((c) => c.name === name)!;

describe('review re-resolves pinned knowledge from the trusted catalog', () => {
  it('approves when the recorded context is exactly the one the pinned selection produces', async () => {
    const { h, ctx } = await pinnedPending();
    record(h, ctx, { ...ctx, attemptFingerprints: [{ attempt: 1, fingerprint: ctx.fingerprint }] });
    const v = await review(h, catalog);
    assert.equal(v.verdict, 'APPROVE', JSON.stringify(v.reasons));
    assert.match(check(v, 'knowledge_selection').detail, /1 pinned knowledge entry recomputed/);
    assert.match(check(v, 'engineering_context').detail, /matches the task contract/);
  });

  it('escalates when no trusted catalog is configured for review', async () => {
    const { h, ctx } = await pinnedPending();
    record(h, ctx, { ...ctx, attemptFingerprints: [{ attempt: 1, fingerprint: ctx.fingerprint }] });
    const v = await review(h, undefined);
    assert.equal(v.verdict, 'ESCALATE');
    assert.ok(v.reasons.includes('knowledge_selection'));
  });

  it('escalates when a selected entry was changed or revoked after the task was pinned', async () => {
    const { h, ctx } = await pinnedPending();
    record(h, ctx, { ...ctx, attemptFingerprints: [{ attempt: 1, fingerprint: ctx.fingerprint }] });
    const changed = new EngineeringKnowledgeCatalog([entry('rule-one', 'Guidance rule-one: skip the tests.'), entry('rule-two')]);
    assert.ok((await review(h, changed)).reasons.includes('knowledge_selection'));
    const revoked = new EngineeringKnowledgeCatalog([entry('rule-two')]);
    const v = await review(h, revoked);
    assert.equal(v.verdict, 'ESCALATE');
    assert.match(check(v, 'knowledge_selection').detail, /unknown entry rule-one/);
  });

  it('an UNRELATED catalog change does not block review', async () => {
    const { h, ctx } = await pinnedPending();
    record(h, ctx, { ...ctx, attemptFingerprints: [{ attempt: 1, fingerprint: ctx.fingerprint }] });
    const grown = new EngineeringKnowledgeCatalog([entry('rule-one'), entry('rule-two', 'Guidance rule-two: rewritten.'), entry('rule-three')]);
    assert.equal((await review(h, grown)).verdict, 'APPROVE');
  });

  it('F-13: a knowledge-pinned task whose worker recorded NO context snapshot cannot be approved', async () => {
    const { h, ctx } = await pinnedPending();
    record(h, ctx, null, undefined);
    const v = await review(h, catalog);
    assert.equal(v.verdict, 'ESCALATE');
    assert.match(check(v, 'engineering_context').detail, /is missing/);
  });

  it('the worker consumed a context WITHOUT the pinned knowledge (or with other knowledge): escalated', async () => {
    const { h, files } = await pinnedPending();
    const without = buildEngineeringContext(files);
    record(h, without, { ...without, attemptFingerprints: [{ attempt: 1, fingerprint: without.fingerprint }] });
    const v = await review(h, catalog);
    assert.equal(v.verdict, 'ESCALATE');
    assert.match(check(v, 'engineering_context').detail, /not the one the task contract pins/);
    const other = buildEngineeringContext(files, undefined, undefined, catalog.resolve({ language: 'go', ids: ['rule-two'] }));
    record(h, other, { ...other, attemptFingerprints: [{ attempt: 1, fingerprint: other.fingerprint }] });
    assert.ok((await review(h, catalog)).reasons.includes('engineering_context'));
  });
});
