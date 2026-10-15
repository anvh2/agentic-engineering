/**
 * Curated engineering knowledge inspired by ECC's selective rules, learning and hooks.
 * SECURITY: This catalog is DATA ONLY. It never executes scripts, registers tools,
 * modifies delegation policies, or authorizes agent/approval actions.
 */
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export type KnowledgeLanguage = 'go' | 'js' | 'ts';
export type KnowledgeKind = 'rule' | 'skill' | 'adr' | 'lesson' | 'role';
export type KnowledgeEntry = Readonly<{
  id: string;
  revision: string;
  kind: KnowledgeKind;
  language: KnowledgeLanguage | 'common';
  body: string;
  source: string;
  /** Only independently accepted content may be injected. */
  approved: boolean;
}>;

export type KnowledgeSelection = Readonly<{
  entries: readonly KnowledgeEntry[];
  digest: string;
  text: string;
  bytes: number;
  omitted: readonly string[];
}>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const ID = /^[a-z][a-z0-9-]{1,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 16_384;
const MAX_ENTRY_COUNT = 128;
const MAX_BUDGET_BYTES = 64_000;
const RESERVED_TOKENS = /\b(?:ALLOW_ALL|OVERRIDE_SANDBOX|DISABLE_VERIFIER)\b/g;

function stableEntries(entries: readonly KnowledgeEntry[]): KnowledgeEntry[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision));
}
function safeEntry(e: KnowledgeEntry): KnowledgeEntry {
  if (!ID.test(e.id) || !ID.test(e.revision) || !['rule','skill','adr','lesson','role'].includes(e.kind)
    || !['go','js','ts','common'].includes(e.language) || !e.source.trim()
    || typeof e.approved !== 'boolean' || !e.body.trim() || Buffer.byteLength(e.body, 'utf8') > MAX_BODY_BYTES
    || e.body.includes('\u0000')) throw new Error('knowledge: invalid manifest entry');
  return Object.freeze({ ...e });
}

export class EngineeringKnowledgeCatalog {
  private readonly entries: readonly KnowledgeEntry[];
  readonly catalogDigest: string;

  constructor(entries: readonly KnowledgeEntry[]) {
    if (entries.length > MAX_ENTRY_COUNT) throw new Error('knowledge: catalog capacity exceeded');
    const checked = stableEntries(entries.map(safeEntry));
    const ids = new Set<string>();
    for (const entry of checked) {
      if (ids.has(entry.id)) throw new Error('knowledge: duplicate entry id');
      ids.add(entry.id);
    }
    this.entries = Object.freeze(checked);
    this.catalogDigest = sha256(JSON.stringify(checked));
  }

  /**
   * Resolve only approved, explicitly selected entries for one known implementation language.
   * No heuristics based on model prose or repository text may request additional entries.
   * Mandatory design and verifier text are outside this budget and must never be dropped.
   */
  resolve(request: { language: KnowledgeLanguage; ids: readonly string[]; maxBytes?: number }): KnowledgeSelection {
    if (!['go','js','ts'].includes(request.language)) throw new Error('knowledge: unsupported language');
    if (request.ids.length > MAX_ENTRY_COUNT || new Set(request.ids).size !== request.ids.length) throw new Error('knowledge: duplicate/oversized selection');
    const budget = request.maxBytes ?? 12_000;
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_BUDGET_BYTES) throw new Error('knowledge: invalid budget');
    const matches: KnowledgeEntry[] = [];
    const omitted: string[] = [];
    let bytes = 0;
    for (const id of [...request.ids].sort()) {
      const e = this.entries.find((entry) => entry.id === id);
      if (!e) throw new Error(`knowledge: unknown entry ${id}`);
      if (!e.approved) throw new Error(`knowledge: entry ${id} not approved`);
      if (e.language !== 'common' && e.language !== request.language) throw new Error(`knowledge: language mismatch for ${id}`);
      const rendered = `### ${e.kind}:${e.id}@${e.revision} (${e.source})\n${e.body}\n`;
      const size = Buffer.byteLength(rendered, 'utf8');
      if (bytes + size > budget) { omitted.push(id); continue; }
      bytes += size;
      matches.push(e);
    }
    const text = matches.map((e) => `### ${e.kind}:${e.id}@${e.revision} (${e.source})\n${e.body}\n`).join('\n');
    return Object.freeze({
      entries: Object.freeze(matches),
      omitted: Object.freeze(omitted),
      text,
      bytes,
      digest: sha256(JSON.stringify(matches.map((e) => [e.id,e.revision,sha256(e.body),e.source])) + '\n' + text),
    });
  }
}

/** Historical lessons are proposals, not instructions, until independent evidence is accepted. */
export type VerifiedOutcome = Readonly<{
  taskId: string;
  projectId: string;
  status: 'PASS' | 'FAIL';
  runtimeVerified: boolean;
  independentlyAccepted: boolean;
  evidenceHash: string;
}>;

export type CandidateLesson = Readonly<{
  id: string;
  projectId: string;
  proposedBody: string;
  evidenceHashes: readonly string[];
  status: 'candidate';
}>;

export function proposeLesson(input: {
  id: string; projectId: string; body: string; outcomes: readonly VerifiedOutcome[];
}): CandidateLesson {
  if (!ID.test(input.id) || !ID.test(input.projectId) || !input.body.trim()
    || Buffer.byteLength(input.body,'utf8') > MAX_BODY_BYTES || input.outcomes.length === 0) {
    throw new Error('knowledge: invalid lesson');
  }
  for (const x of input.outcomes) {
    if (x.projectId !== input.projectId || x.status !== 'PASS'
      || !x.runtimeVerified || !x.independentlyAccepted || !SHA.test(x.evidenceHash)) {
      throw new Error('knowledge: unverified or cross-project lesson evidence');
    }
  }
  return Object.freeze({
    id: input.id, projectId: input.projectId, proposedBody: input.body,
    evidenceHashes: Object.freeze([...new Set(input.outcomes.map((x) => x.evidenceHash))].sort()),
    status: 'candidate' as const,
  });
}

/** Deterministic projection of read-only session checkpoints, not a scheduler or hook executor. */
export type SessionCheckpoint = Readonly<{
  sessionId: string;
  taskId: string;
  seq: number;
  state: string;
  evidenceHash: string;
}>;

export function latestCheckpoint(events: readonly SessionCheckpoint[], sessionId: string): SessionCheckpoint | undefined {
  const filtered = events.filter((e) => e.sessionId === sessionId);
  if (!filtered.length) return undefined;
  if (filtered.some((e) => !Number.isSafeInteger(e.seq) || e.seq < 0 || !SHA.test(e.evidenceHash))) {
    throw new Error('knowledge: malformed session checkpoint');
  }
  const ordered = [...filtered].sort((a,b) => a.seq - b.seq);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.seq === ordered[i-1]!.seq && ordered[i]!.evidenceHash !== ordered[i-1]!.evidenceHash) {
      throw new Error('knowledge: checkpoint sequence conflict');
    }
  }
  return Object.freeze({ ...ordered[ordered.length-1]! });
}

/** Role templates are descriptive instructions and NEVER grant runtime privileges. */
export const SPECIALIST_ROLES = Object.freeze({
  architect: 'Assess HLD/LLD consistency and explicitly list unverified assumptions.',
  securityReviewer: 'Audit trust boundaries, data provenance, scope and failing negative cases.',
  goReviewer: 'Review Go cancellation, errors, package boundaries and targeted tests.',
  jsReviewer: 'Review JS async errors, module boundaries, dependencies and targeted tests.',
  testAnalyst: 'Check independent acceptance and falsifiable negative tests.',
} as const);

/** File language detection intentionally fails closed on mixed/unknown sets. */
export function knowledgeLanguageForFiles(files: readonly string[]): KnowledgeLanguage | undefined {
  if (!files.length) return undefined;
  const languages = files.map((f) => {
    const ext = extname(f);
    if (ext === '.go') return 'go';
    if (['.js','.mjs','.cjs'].includes(ext)) return 'js';
    if (['.ts','.mts','.cts'].includes(ext)) return 'ts';
    return undefined;
  });
  return languages.every((x) => x && x === languages[0]) ? languages[0] : undefined;
}

/** Defense-in-depth diagnostic only; NEVER treat this as prompt-injection resistance. */
export function containsSuspiciousKnowledgeText(body: string): boolean {
  RESERVED_TOKENS.lastIndex = 0;
  return RESERVED_TOKENS.test(body);
}
