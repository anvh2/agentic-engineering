import { randomBytes } from 'node:crypto';
import { entryDigest, type KnowledgeEntry } from '../engineering-knowledge.ts';
import { PROMOTION_DOMAIN, type PromotionAction, type PromotionGrant } from '../engineering-knowledge-store.ts';
import { signStatement } from '../trust.ts';
import type { testIdentity } from './keys.ts';

type Identity = ReturnType<typeof testIdentity>;

export const inactive = (e: Omit<KnowledgeEntry, 'approved'>): KnowledgeEntry => ({ ...e, approved: false });

/** Test-only: what an operator's signing tool would emit for one promotion/revocation. */
export function grantFor(signer: Identity, action: PromotionAction, entry: KnowledgeEntry, extra: Partial<PromotionGrant> = {}) {
  const active = { ...entry, approved: true };
  const grant: PromotionGrant = {
    action, entryId: entry.id, digest: entryDigest(active), projectId: entry.projectId ?? null,
    nonce: randomBytes(12).toString('hex'), expiresAt: Date.now() + 60_000, ...extra,
  };
  return signStatement(signer.privateKeyPem, signer.keyId, PROMOTION_DOMAIN, grant);
}
