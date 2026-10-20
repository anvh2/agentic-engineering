/**
 * Curated engineering knowledge: rules, skills, ADR extracts and lessons that may be placed in a worker prompt.
 *
 * SECURITY: this catalog is DATA ONLY. It never executes scripts, registers tools, changes delegation policy, widens a task's
 * allowed files / verifier argv, or authorizes an approval. Everything in it is untrusted instructional text to the model.
 *
 * Trust model (changed from the first PR #53 revision, see docs/engineering/audit/findings-register.md):
 *  - Entries are scoped. `projectId === undefined` is global curated content; otherwise the entry exists only for that
 *    project, and a catalog built for project B cannot contain it (F-03).
 *  - A task pins the digest of exactly the entries it selected, not the digest of the whole catalog, so promoting or revoking
 *    an UNRELATED entry cannot invalidate in-flight work (F-06), while a changed or revoked SELECTED entry still does.
 *  - Language comes from the single runtime language registry, so the runner and the reviewer cannot disagree (F-12).
 */
import { extname } from 'node:path';
import { detectLanguage } from '../execution/language-adapters.ts';
import { hashValue, sha256Hex } from './canonical.ts';

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
  /** Absent = global curated content. Present = visible only to a catalog built for exactly this project. */
  projectId?: string;
}>;

export type KnowledgeSelection = Readonly<{
  entries: readonly KnowledgeEntry[];
  /** Digest of exactly the selected entries (id, revision, content) and their rendered text. A task pins this. */
  digest: string;
  text: string;
  bytes: number;
  omitted: readonly string[];
}>;

const ID = /^[a-z][a-z0-9-]{1,79}$/;
const KINDS: readonly string[] = ['rule', 'skill', 'adr', 'lesson', 'role'];
const LANGUAGES: readonly string[] = ['go', 'js', 'ts', 'common'];
const MAX_BODY_BYTES = 16_384;
const MAX_ENTRY_COUNT = 256;
const MAX_BUDGET_BYTES = 64_000;
const RESERVED_TOKENS = /\b(?:ALLOW_ALL|OVERRIDE_SANDBOX|DISABLE_VERIFIER)\b/;

export const entryDigest = (e: KnowledgeEntry): string => hashValue({
  id: e.id, revision: e.revision, kind: e.kind, language: e.language, body: e.body, source: e.source, approved: e.approved, projectId: e.projectId ?? null,
});

function safeEntry(e: KnowledgeEntry): KnowledgeEntry {
  if (!e || typeof e !== 'object' || !ID.test(e.id) || !ID.test(e.revision) || !KINDS.includes(e.kind) || !LANGUAGES.includes(e.language)
    || typeof e.source !== 'string' || !e.source.trim() || typeof e.approved !== 'boolean' || typeof e.body !== 'string' || !e.body.trim()
    || Buffer.byteLength(e.body, 'utf8') > MAX_BODY_BYTES || e.body.includes('\u0000')
    || (e.projectId !== undefined && !ID.test(e.projectId))) throw new Error('knowledge: invalid manifest entry');
  return Object.freeze({ ...e });
}

const render = (e: KnowledgeEntry): string => `### ${e.kind}:${e.id}@${e.revision} (${e.source})\n${e.body}\n`;

export class EngineeringKnowledgeCatalog {
  private readonly entries: readonly KnowledgeEntry[];
  /** Digest of the whole catalog, for status display only. Tasks pin selection digests, never this. */
  readonly catalogDigest: string;
  readonly projectId: string | undefined;

  constructor(entries: readonly KnowledgeEntry[], options: { projectId?: string } = {}) {
    if (entries.length > MAX_ENTRY_COUNT) throw new Error('knowledge: catalog capacity exceeded');
    this.projectId = options.projectId;
    const checked = entries.map(safeEntry).sort((a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision));
    const ids = new Set<string>();
    for (const entry of checked) {
      if (ids.has(entry.id)) throw new Error('knowledge: duplicate entry id');
      ids.add(entry.id);
      if (entry.projectId !== undefined && entry.projectId !== options.projectId) throw new Error(`knowledge: entry ${entry.id} belongs to another project`);
    }
    this.entries = Object.freeze(checked);
    this.catalogDigest = hashValue(checked.map(entryDigest));
  }

  list(): readonly KnowledgeEntry[] { return this.entries; }

  /**
   * Resolve only approved, explicitly selected entries for one known implementation language. No heuristic based on model
   * prose or repository text may add entries. Mandatory design and verifier text live outside this budget and are never
   * dropped by it: an over-budget selection is reported in `omitted`, and callers treat that as an error.
   */
  resolve(request: { language: KnowledgeLanguage; ids: readonly string[]; maxBytes?: number }): KnowledgeSelection {
    if (!['go', 'js', 'ts'].includes(request.language)) throw new Error('knowledge: unsupported language');
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
      const size = Buffer.byteLength(render(e), 'utf8');
      if (bytes + size > budget) { omitted.push(id); continue; }
      bytes += size;
      matches.push(e);
    }
    const text = matches.map(render).join('\n');
    return Object.freeze({
      entries: Object.freeze(matches),
      omitted: Object.freeze(omitted),
      text,
      bytes,
      digest: sha256Hex(hashValue(matches.map(entryDigest)) + '\n' + text),
    });
  }
}

/**
 * The single place that turns a task's allowed files into a knowledge language. It delegates to the runtime language
 * registry, so the runner (which builds the prompt) and the reviewer (which recomputes it) cannot diverge.
 */
export function knowledgeLanguageForFiles(files: readonly string[]): KnowledgeLanguage | undefined {
  if (!files.length) return undefined;
  return detectLanguage(files.map((f) => extname(f)));
}

/** Defense-in-depth diagnostic only; NEVER treat this as prompt-injection resistance. */
export function containsSuspiciousKnowledgeText(body: string): boolean {
  return RESERVED_TOKENS.test(body);
}
