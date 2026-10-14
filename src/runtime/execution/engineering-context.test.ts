import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEngineeringContext } from './engineering-context.ts';

const approved = {
  approvalRef: 'ADR-014@abc123',
  hld: 'All admission decisions belong to the scheduler.',
  lld: 'Never allocate more than two permits; FIFO is ticket-based.',
  adr: ['Disallow direct Oracle access from coding workers.'],
};

describe('approved design and convention context', () => {
  it('injects the same HLD/LLD into Go and TypeScript with distinct conventions', () => {
    const go = buildEngineeringContext(['src/queue.go'], approved);
    const ts = buildEngineeringContext(['src/queue.ts'], approved);
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
    const a = buildEngineeringContext(['src/queue.go'], approved);
    const b = buildEngineeringContext(['src/queue.go'], { ...approved });
    const c = buildEngineeringContext(['src/queue.go'], { ...approved, lld: 'Different invariant' });
    assert.deepEqual(a, b);
    assert.notEqual(a.manifestHash, c.manifestHash);
  });

  it('never invents approval in legacy contracts', () => {
    const ctx = buildEngineeringContext(['src/queue.go']);
    assert.match(ctx.text, /No approved HLD\/LLD attached/);
    assert.doesNotMatch(ctx.text, /ADR-014@abc123/);
  });

  it('refuses incomplete approvals, unknown and mixed implementation languages', () => {
    assert.throws(() => buildEngineeringContext(['src/a.go'], { ...approved, lld: '' }), /requires HLD, LLD and approvalRef/);
    assert.throws(() => buildEngineeringContext(['src/a.go'], { ...approved, approvalRef: ' ' }), /requires HLD, LLD and approvalRef/);
    assert.throws(() => buildEngineeringContext(['src/a.rb']), /unknown or mixed/);
    assert.throws(() => buildEngineeringContext(['src/a.go', 'src/b.ts']), /unknown or mixed/);
  });

  it('does not enable the disabled TypeScript worker just by providing its conventions', () => {
    const ctx = buildEngineeringContext(['src/queue.ts'], approved);
    assert.equal(ctx.language, 'ts');
    assert.match(ctx.text, /delegation is disabled/);
  });
});
