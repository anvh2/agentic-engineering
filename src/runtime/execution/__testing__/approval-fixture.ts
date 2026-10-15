import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SchedulerStore } from '../../scheduler/store.ts';
import { makeStore, plan, workerTask } from '../../scheduler/test-helpers.ts';
import { DesignApprovalStore, approveDigest, createApprovalVerifier, issueApproval, designFingerprint, revokeDigest, type ApprovalAuthority, type DelegatedAuthority, type DesignContent } from '../design-approval.ts';

/**
 * TEST-ONLY authority. It really verifies a MAC over the exact request digest (so replay, wrong-key and wrong-request cases
 * are genuine), but it is not a production trust root: the keys live in the test process. Production ships no authority.
 */
export class TestAuthority implements ApprovalAuthority {
  private readonly keys = new Map<string, { key: string; grantId: string }>();
  readonly grants = new Map<string, DelegatedAuthority>();

  /** Registers a principal that holds `key` and acts under `grant`. */
  enroll(principalId: string, key: string, grant: DelegatedAuthority): this {
    this.keys.set(principalId, { key, grantId: grant.grantId });
    this.grants.set(grant.grantId, grant);
    return this;
  }

  /** The credential `principalId` would present for `digest`: `<principalId>.<hmac>`. */
  static credential(principalId: string, key: string, digest: string): string {
    return `${principalId}.${createHmac('sha256', key).update(digest).digest('hex')}`;
  }

  authenticate(credential: string, digest: string) {
    const [principalId, mac] = credential.split('.');
    const entry = this.keys.get(principalId ?? '');
    if (!entry || !mac) return undefined;
    const expected = createHmac('sha256', entry.key).update(digest).digest('hex');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? { principalId: principalId!, grantId: entry.grantId } : undefined;
  }

  grant(grantId: string) {
    return this.grants.get(grantId);
  }
}

export const LEAD_KEY = 'lead-test-key';

export function leadGrant(overrides: Partial<DelegatedAuthority> = {}): DelegatedAuthority {
  return {
    grantId: 'grant-lead-1',
    role: 'engineering-lead',
    actions: ['approve', 'revoke'],
    scope: { objectiveIds: ['obj1'], languages: ['go', 'js'], pathPrefixes: ['src/', 'calc/'], maxRisk: 'low' },
    ...overrides,
  };
}

/** The credential `principalId` would present to approve `design` for a task, for the revision the store would assign next (or an explicit one). */
export function approveCredential(store: SchedulerStore, principalId: string, key: string, objectiveId: string, taskId: string, design: DesignContent, revision?: number): string {
  const rev = revision ?? new DesignApprovalStore(store).nextRevision(objectiveId, taskId);
  return TestAuthority.credential(principalId, key, approveDigest({ objectiveId, taskId, designFingerprint: designFingerprint(design), revision: rev }));
}
export const revokeCredential = (principalId: string, key: string, approvalId: string) => TestAuthority.credential(principalId, key, revokeDigest({ approvalId }));

/**
 * A scheduler store holding one worker task, a lead authority whose grant covers it, and a real approval record for `design`.
 * `approvedDesign` is what a task contract would carry; `verifier` is what the runtime would use to check it.
 */
export function approvedTask(taskId: string, files: string[], design: DesignContent, objectiveId = 'obj1') {
  const store = makeStore();
  store.createBatch(plan('/repo', [workerTask(taskId, { files })], { batchId: objectiveId }));
  const authority = new TestAuthority().enroll('lead-1', LEAD_KEY, leadGrant({ scope: { objectiveIds: [objectiveId], languages: ['go', 'js'], pathPrefixes: [...new Set(files.map((f) => `${f.split('/')[0]}/`))], maxRisk: 'low' } }));
  const { approvalId } = issueApproval({ store, authority }, { objectiveId, taskId, design, credential: approveCredential(store, 'lead-1', LEAD_KEY, objectiveId, taskId, design) });
  return {
    store,
    authority,
    approvalId,
    verifier: createApprovalVerifier({ store, authority }),
    approvedDesign: { hld: design.hld, lld: design.lld, ...(design.adr ? { adr: [...design.adr] } : {}), approvalRef: approvalId },
  };
}
