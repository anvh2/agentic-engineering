import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENGINEERING_CONTEXT_SCHEMA_VERSION, buildEngineeringContext, verifyEngineeringContext, type ApprovedDesign, type DesignDigests } from './engineering-context.ts';

// A hand-built VerifiedApproval: this suite tests the pure context builder. Producing real ones is design-approval.test.ts.
const approval = { approvalId: 'ADR-014@abc123', revision: 3, designFingerprint: 'f'.repeat(64), approverId: 'lead-1', role: 'engineering-lead', grantId: 'grant-1', approvedAt: 1 };
const approved = {
  approvalRef: 'ADR-014@abc123',
  hld: 'All admission decisions belong to the scheduler.',
  lld: 'Never allocate more than two permits; FIFO is ticket-based.',
  adr: ['Disallow direct Oracle access from coding workers.'],
};

describe('approved design and convention context', () => {
  it('injects the same HLD/LLD into Go and TypeScript with distinct conventions', () => {
    const go = buildEngineeringContext(['src/queue.go'], approved, approval);
    const ts = buildEngineeringContext(['src/queue.ts'], approved, approval);
    for (const ctx of [go, ts]) {
      assert.match(ctx.text, /All admission decisions belong to the scheduler/);
      assert.match(ctx.text, /Never allocate more than two permits/);
      assert.match(ctx.text, /ADR-014@abc123/);
      assert.match(ctx.text, /Disallow direct Oracle access/);
      assert.match(ctx.text, /runtime verifier and independent reviewer/);
      assert.match(ctx.manifestHash, /^[a-f0-9]{64}$/);
    }
    assert.match(go.text, /idiomatic Go naming/);
    assert.match(ts.text, /tsconfig, strict typing/);
    assert.notEqual(go.manifestHash, ts.manifestHash);
  });

  it('is deterministic and changes the manifest when the approved design changes', () => {
    const a = buildEngineeringContext(['src/queue.go'], approved, approval);
    const b = buildEngineeringContext(['src/queue.go'], { ...approved }, approval);
    const c = buildEngineeringContext(['src/queue.go'], { ...approved, lld: 'Different invariant' }, approval);
    assert.deepEqual(a, b);
    assert.notEqual(a.manifestHash, c.manifestHash);
  });

  it('never invents approval in legacy contracts', () => {
    const ctx = buildEngineeringContext(['src/queue.go']);
    assert.match(ctx.text, /No approved HLD\/LLD attached/);
    assert.doesNotMatch(ctx.text, /ADR-014@abc123/);
  });

  it('refuses incomplete approvals, unknown and mixed implementation languages', () => {
    assert.throws(() => buildEngineeringContext(['src/a.go'], { ...approved, lld: '' }, approval), /requires HLD, LLD and approvalRef/);
    assert.throws(() => buildEngineeringContext(['src/a.go'], { ...approved, approvalRef: ' ' }, approval), /requires HLD, LLD and approvalRef/);
    assert.throws(() => buildEngineeringContext(['src/a.rb']), /unknown or mixed/);
    assert.throws(() => buildEngineeringContext(['src/a.go', 'src/b.ts']), /unknown or mixed/);
  });

  it('does not enable the disabled TypeScript worker just by providing its conventions', () => {
    const ctx = buildEngineeringContext(['src/queue.ts'], approved, approval);
    assert.equal(ctx.language, 'ts');
    assert.match(ctx.text, /delegation is disabled/);
  });

  describe('immutable, versioned snapshot', () => {
    it('is versioned, deep-frozen and fingerprints exactly the prompt body', () => {
      const ctx = buildEngineeringContext(['src/queue.go'], approved, approval);
      assert.equal(ctx.schemaVersion, ENGINEERING_CONTEXT_SCHEMA_VERSION);
      assert.equal(ctx.fingerprint, ctx.manifestHash);
      assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.approval) && Object.isFrozen(ctx.design));
      assert.throws(() => { (ctx as { text: string }).text = 'tampered'; }, TypeError);
      assert.throws(() => { (ctx.approval as { status: string }).status = 'verified'; }, TypeError);
      assert.deepEqual(verifyEngineeringContext(ctx), { ok: true });
    });

    it('records the verified approval it was given and marks legacy tasks as having none', () => {
      assert.deepEqual(buildEngineeringContext(['src/queue.go'], approved, approval).approval, { status: 'verified', ...approval });
      const legacy = buildEngineeringContext(['src/queue.go']);
      assert.deepEqual(legacy.approval, { status: 'none' });
      assert.equal(legacy.design, null);
    });

    it('digests every design part so a changed HLD, LLD or ADR is visible in evidence', () => {
      const base = buildEngineeringContext(['src/queue.go'], approved, approval);
      const cases: [keyof DesignDigests, Partial<ApprovedDesign>][] = [['hldSha256', { hld: 'other' }], ['lldSha256', { lld: 'other' }], ['adrSha256', { adr: ['other'] }]];
      for (const [field, changed] of cases) {
        const next = buildEngineeringContext(['src/queue.go'], { ...approved, ...changed }, approval);
        assert.notEqual(next.design![field], base.design![field], field);
        assert.notEqual(next.fingerprint, base.fingerprint, `${field} changes the fingerprint`);
      }
    });

    it('refuses an attached design with no verified approval, or with the approval of a different reference', () => {
      assert.throws(() => buildEngineeringContext(['src/queue.go'], approved), /requires a verified approval record/);
      assert.throws(() => buildEngineeringContext(['src/queue.go'], approved, { ...approval, approvalId: 'da-other' }), /not the one the design references/);
    });

    it('verification fails closed on a tampered body, header, fingerprint or malformed text', () => {
      const ctx = buildEngineeringContext(['src/queue.go'], approved, approval);
      const bodyEdited = { ...ctx, text: ctx.text.replace('Never allocate more than two permits', 'Allocate without limit') };
      assert.equal(verifyEngineeringContext(bodyEdited).ok, false);
      assert.equal(verifyEngineeringContext({ ...ctx, fingerprint: 'f'.repeat(64) }).ok, false);
      assert.equal(verifyEngineeringContext({ ...ctx, text: ctx.text.replace(/SHA-256: [a-f0-9]{64}/, `SHA-256: ${'0'.repeat(64)}`) }).ok, false);
      assert.equal(verifyEngineeringContext({ ...ctx, text: 'no header at all' }).ok, false);
    });
  });
});
