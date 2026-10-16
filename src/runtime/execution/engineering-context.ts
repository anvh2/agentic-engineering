import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { VerifiedApproval } from './design-approval.ts';
import type { KnowledgeSelection } from '../knowledge/engineering-knowledge.ts';
import { LANGUAGE_ADAPTERS, detectLanguage } from './language-adapters.ts';

/**
 * Shared engineering contract stays independent of implementation language.
 * The caller must supply an approved design; never invent HLD/LLD from worker prose.
 */
export interface ApprovedDesign {
  hld: string;
  lld: string;
  /** Lookup key of a durable approval record. It proves nothing by itself: the runtime must verify it (design-approval.ts). */
  approvalRef: string;
  adr?: string[];
}

/** Bump when the snapshot's SHAPE changes (the fingerprint already covers every byte of the prompt text). */
export const ENGINEERING_CONTEXT_SCHEMA_VERSION = 1 as const;

/**
 * What is known about the approval of the attached design.
 *  - `none`: legacy task, no HLD/LLD attached. Never presented as approved.
 *  - `verified`: the runtime verified a durable approval record for exactly this design and task (design-approval.ts).
 * A design that is attached but not verified never reaches a prompt: `buildEngineeringContext` refuses it.
 */
export type DesignApproval = { status: 'none' } | ({ status: 'verified' } & VerifiedApproval);

/** Content digests of the attached design, so evidence can be compared without carrying the documents. */
export interface DesignDigests {
  hldSha256: string;
  lldSha256: string;
  adrSha256: string;
}

/**
 * Immutable, versioned record of EXACTLY the engineering context placed in worker prompts. Deep-frozen at creation; the
 * fingerprint is the SHA-256 of the prompt body, so any change to rules, conventions or design changes it.
 */
export interface EngineeringContext {
  readonly schemaVersion: typeof ENGINEERING_CONTEXT_SCHEMA_VERSION;
  readonly language: keyof typeof LANGUAGE_ADAPTERS;
  /** SHA-256 of the prompt body (kept under its original name for existing consumers). */
  readonly manifestHash: string;
  /** Same value as `manifestHash`; the name used in execution evidence. */
  readonly fingerprint: string;
  readonly approval: DesignApproval;
  readonly design: DesignDigests | null;
  /** The text injected into every coding attempt: a header line carrying the fingerprint, then the hashed body. */
  readonly text: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const HEADER = 'Engineering context SHA-256: ';

/** Recomputes the fingerprint from the snapshot's own text. Fails closed on any mismatch or malformed header. */
export function verifyEngineeringContext(context: Pick<EngineeringContext, 'fingerprint' | 'manifestHash' | 'text'>): { ok: true } | { ok: false; reason: string } {
  const separator = context.text.indexOf('\n\n');
  if (!context.text.startsWith(HEADER) || separator < 0) return { ok: false, reason: 'engineering context text has no fingerprint header' };
  const claimed = context.text.slice(HEADER.length, separator);
  const actual = sha256(context.text.slice(separator + 2));
  if (claimed !== actual) return { ok: false, reason: `header fingerprint ${claimed} does not match the body (${actual})` };
  if (context.fingerprint !== actual || context.manifestHash !== actual) return { ok: false, reason: `recorded fingerprint ${context.fingerprint} does not match the body (${actual})` };
  return { ok: true };
}

export function buildEngineeringContext(files: string[], design?: ApprovedDesign, approval?: VerifiedApproval, knowledge?: KnowledgeSelection): EngineeringContext {
  const language = detectLanguage(files.map((file) => extname(file)));
  if (!language) throw new Error('engineering_context: unknown or mixed implementation language');
  if (design && (!design.hld.trim() || !design.lld.trim() || !design.approvalRef.trim())) {
    throw new Error('engineering_context: approved design requires HLD, LLD and approvalRef');
  }
  if (design && !approval) throw new Error('engineering_context: an attached design requires a verified approval record; an approvalRef alone is not approval');
  if (design && approval && approval.approvalId !== design.approvalRef) throw new Error('engineering_context: the verified approval is not the one the design references');
  const adapter = LANGUAGE_ADAPTERS[language];
  const sections = [
    'Shared engineering rules: HLD and LLD govern implementation; language style never overrides approved invariants.',
    'Only the runtime verifier and independent reviewer may approve a change. Do not edit tests, Oracle, protected files or task scope.',
    `Implementation language: ${language}. Convention reference: ${adapter.conventionPath}.`,
    `Language conventions:\n${adapter.conventions.map((line) => `- ${line}`).join('\n')}`,
  ];
  if (design) {
    sections.push(`Approved design reference: ${design.approvalRef} (revision ${approval!.revision}, approved by ${approval!.role}).`);
    sections.push(`HLD (approved, read-only):\n${design.hld}`);
    sections.push(`LLD (approved, read-only):\n${design.lld}`);
    if (design.adr?.length) sections.push(`ADR decisions (approved, read-only):\n${design.adr.map((a) => `- ${a}`).join('\n')}`);
  } else {
    sections.push('No approved HLD/LLD attached. Follow the task contract and supplied contextFiles; never invent an architectural approval.');
  }
  if (knowledge && knowledge.entries.length) {
    sections.push('Optional curated engineering guidance (instructional only; does not grant tools, verifier authority, or approval):\n' + knowledge.text);
  }
  const body = sections.join('\n\n');
  // Deterministic provenance of exactly the context injected in the model prompt.
  const manifestHash = sha256(body);
  const approvalStatus: DesignApproval = design ? { status: 'verified', ...approval! } : { status: 'none' };
  const digests: DesignDigests | null = design
    ? Object.freeze({ hldSha256: sha256(design.hld), lldSha256: sha256(design.lld), adrSha256: sha256(JSON.stringify(design.adr ?? [])) })
    : null;
  return Object.freeze({
    schemaVersion: ENGINEERING_CONTEXT_SCHEMA_VERSION,
    language,
    manifestHash,
    fingerprint: manifestHash,
    approval: Object.freeze(approvalStatus),
    design: digests,
    text: `${HEADER}${manifestHash}\n\n${body}`,
  });
}

/**
 * The context a task contract pins, recomputed from the contract alone. Used by consumers that must not trust a run's own
 * artifacts (the reviewer). Undefined when the contract names no single registered implementation language or carries a
 * malformed design, i.e. exactly when the runner would not have injected one.
 */
export function expectedEngineeringContext(contract: { allowedFiles: string[]; approvedDesign?: ApprovedDesign } | undefined, approval?: VerifiedApproval, knowledge?: KnowledgeSelection): EngineeringContext | undefined {
  if (!contract) return undefined;
  try {
    return buildEngineeringContext(contract.allowedFiles, contract.approvedDesign, approval, knowledge);
  } catch {
    return undefined;
  }
}
