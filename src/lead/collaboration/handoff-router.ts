/**
 * Deterministic AGENT_HANDOFF_V1 router for PR comments. No LLM, no network, no execution: a pure decision function over untrusted
 * comment text, plus a small durable store. The CLI (scripts/pr-router.ts) and the GitHub Actions workflow both call it.
 *
 * Trust model (see docs/operations/agent-handoff-router.md):
 *  - A comment is DATA. Only fixed header lines are parsed; the body is never interpreted, echoed or executed.
 *  - Author authentication is the GitHub account, against an explicit login allow-list only. The `FROM:` header is
 *    a CLAIM: when several agents post through one account it cannot distinguish them, so no decision here treats it as approval.
 *  - The router only acknowledges transport (PONG) and queues review requests. It never approves, passes, merges or runs anything.
 *  - Router output is labelled ROUTER_GENERATED and addressed FROM `Router-Bridge`; it can never be mistaken for a reviewer's message.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROTOCOL = 'AGENT_HANDOFF_V1';
export const ROUTER_ID = 'Router-Bridge';
export const KNOWN_AGENTS: readonly string[] = Object.freeze(['Claude-Engineering-Lead', 'ChatGPT-Independent-Reviewer', 'Codex-Engineering-Lead']);
export const MESSAGE_TYPES: readonly string[] = Object.freeze(['PING', 'PONG', 'QUESTION', 'REVIEW_REQUEST', 'REVIEW_RESPONSE', 'PROGRESS', 'READY_FOR_REVIEW', 'CONSOLIDATION_REQUEST', 'ROUTER_ACK']);
const HEADER_KEYS: readonly string[] = Object.freeze(['FROM', 'TO', 'TYPE', 'MESSAGE_ID', 'IN_REPLY_TO', 'HEAD_SHA', 'STATUS', 'ROUTER_GENERATED']);
const MAX_BODY_BYTES = 65_536;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
const AGENT_ID = /^[A-Za-z][A-Za-z0-9-]{2,63}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const HEADER_VALUE = /^[A-Za-z0-9._:/<>-]{1,128}$/;
const MAX_PROCESSED = 2000;

export interface GhComment { id: number; body: string; login: string; association: string; createdAt: string; url: string }

export type Handoff = Readonly<{
  from: string; to: string; type: string; messageId: string; inReplyTo: string | undefined; headSha: string; status: string; routerGenerated: boolean;
}>;
export type ParseResult = { ok: true; handoff: Handoff } | { ok: false; reason: string };

/** Parses ONLY the header block (first line `AGENT_HANDOFF_V1`, then `KEY: value` lines up to the first blank line). */
export function parseHandoff(body: string): ParseResult {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY_BYTES) return { ok: false, reason: 'body missing or too large' };
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== PROTOCOL) return { ok: false, reason: 'not an AGENT_HANDOFF_V1 message' };
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === '') break;
    const m = /^([A-Z_]{2,32}):[ \t]*(.*)$/.exec(line);
    if (!m) return { ok: false, reason: 'malformed header line' };
    const [, key, value] = m as unknown as [string, string, string];
    if (!HEADER_KEYS.includes(key)) continue; // unknown keys are ignored, never interpreted
    if (fields.has(key)) return { ok: false, reason: `duplicate header ${key}` };
    if (!HEADER_VALUE.test(value.trim())) return { ok: false, reason: `invalid value for ${key}` };
    fields.set(key, value.trim());
  }
  for (const key of ['FROM', 'TO', 'TYPE', 'MESSAGE_ID', 'HEAD_SHA', 'STATUS']) if (!fields.has(key)) return { ok: false, reason: `missing header ${key}` };
  const get = (k: string) => fields.get(k)!;
  if (!AGENT_ID.test(get('FROM')) || !AGENT_ID.test(get('TO'))) return { ok: false, reason: 'invalid agent id' };
  if (!MESSAGE_TYPES.includes(get('TYPE'))) return { ok: false, reason: 'unknown message type' };
  if (!MESSAGE_ID.test(get('MESSAGE_ID'))) return { ok: false, reason: 'invalid message id' };
  const reply = fields.get('IN_REPLY_TO');
  if (reply !== undefined && reply !== 'none' && !MESSAGE_ID.test(reply)) return { ok: false, reason: 'invalid in-reply-to' };
  if (!SHA40.test(get('HEAD_SHA')) && get('HEAD_SHA') !== 'LOCAL_ONLY') return { ok: false, reason: 'HEAD_SHA must be 40 lowercase hex or LOCAL_ONLY' };
  return { ok: true, handoff: Object.freeze({
    from: get('FROM'), to: get('TO'), type: get('TYPE'), messageId: get('MESSAGE_ID'), inReplyTo: reply === undefined || reply === 'none' ? undefined : reply,
    headSha: get('HEAD_SHA'), status: get('STATUS'), routerGenerated: fields.get('ROUTER_GENERATED') === 'true',
  }) };
}

export type Action = 'ignore' | 'reply-pong' | 'queue-review' | 'reject-review' | 'inbox' | 'record';
export type Decision = Readonly<{ action: Action; reason: string; handoff?: Handoff; shaCurrent?: boolean }>;

export interface RouterContext {
  /** Exact current head of the pull request, fetched from GitHub by the caller (never taken from a comment). */
  prHeadSha: string;
  allowedLogins: readonly string[];
  /** Message ids that already have a router reply or were processed before. */
  handled: ReadonlySet<string>;
}

/**
 * Trust is the explicit login allow-list and nothing else. Repository association (OWNER/MEMBER/COLLABORATOR) is deliberately NOT
 * enough: in a repository with several collaborators it would let any of them queue requests or forge an "answer" that suppresses a
 * real message. The workflow may use association as a cheap pre-filter, but the router decides on logins.
 */
export const isTrustedAuthor = (c: GhComment, allowedLogins: readonly string[]): boolean => allowedLogins.includes(c.login);

/** Pure. Loop guard first, then authentication, then validation, then idempotency, then the (small) set of permitted reactions. */
export function decide(comment: GhComment, ctx: RouterContext): Decision {
  const parsed = parseHandoff(comment.body);
  if (!parsed.ok) return { action: 'ignore', reason: parsed.reason };
  const h = parsed.handoff;
  // Loop guard: anything claiming to be router output, or sent as the router, is never reacted to.
  if (h.routerGenerated || h.from === ROUTER_ID || h.type === 'ROUTER_ACK') return { action: 'ignore', reason: 'router-generated message', handoff: h };
  if (!isTrustedAuthor(comment, ctx.allowedLogins)) return { action: 'ignore', reason: 'author is not authorized', handoff: h };
  if (!KNOWN_AGENTS.includes(h.from)) return { action: 'ignore', reason: 'unknown sender', handoff: h };
  if (!KNOWN_AGENTS.includes(h.to)) return { action: 'ignore', reason: 'unknown recipient', handoff: h };
  if (ctx.handled.has(h.messageId)) return { action: 'ignore', reason: 'duplicate message id', handoff: h };
  if (h.type === 'PING') return { action: 'reply-pong', reason: 'transport handshake', handoff: h };
  if ((h.type === 'REVIEW_REQUEST' || h.type === 'READY_FOR_REVIEW') && h.to === 'ChatGPT-Independent-Reviewer') {
    if (h.headSha === 'LOCAL_ONLY') return { action: 'reject-review', reason: 'a review request must name a pushed SHA', handoff: h, shaCurrent: false };
    return { action: 'queue-review', reason: h.headSha === ctx.prHeadSha ? 'queued for independent review' : 'queued, but the SHA is not the current PR head', handoff: h, shaCurrent: h.headSha === ctx.prHeadSha };
  }
  if (h.to === 'Claude-Engineering-Lead' || h.to === 'Codex-Engineering-Lead') return { action: 'inbox', reason: 'addressed to the engineering lead', handoff: h };
  return { action: 'record', reason: 'recorded; no router reaction defined', handoff: h };
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex');

/** The only text the router ever posts. Every dynamic field is a value that already passed header validation. */
export function renderRouterReply(d: Decision, source: GhComment, prHeadSha: string): { body: string; messageId: string } | undefined {
  if (!d.handoff || (d.action !== 'reply-pong' && d.action !== 'queue-review' && d.action !== 'reject-review')) return undefined;
  const h = d.handoff;
  const isPong = d.action === 'reply-pong';
  const messageId = `router-${digest(`${source.id}:${h.messageId}:${d.action}`).slice(0, 20)}`;
  const status = isPong ? 'TRANSPORT_OK' : d.action === 'queue-review' ? (d.shaCurrent ? 'QUEUED' : 'QUEUED_STALE_SHA') : 'REJECTED_NO_PUSHED_SHA';
  const details = isPong
    ? ['Automatic reply from the deterministic comment router (no LLM involved).', 'It proves that this PR comment was received and parsed. It is NOT an acknowledgement by ChatGPT or any reviewer.']
    : ['Automatic reply from the deterministic comment router (no LLM involved).',
      d.action === 'queue-review'
        ? 'The review request was recorded in the router queue for ChatGPT\'s scheduled independent review. No review has happened yet.'
        : 'The request was not queued because it names no pushed commit.',
      `Queued SHA matches current PR head: ${d.shaCurrent ? 'yes' : 'no'}.`, 'This reply is not a review, an approval or a test result.'];
  const body = [PROTOCOL, `FROM: ${ROUTER_ID}`, `TO: ${h.from}`, `TYPE: ${isPong ? 'PONG' : 'ROUTER_ACK'}`, `MESSAGE_ID: ${messageId}`, `IN_REPLY_TO: ${h.messageId}`,
    `HEAD_SHA: ${prHeadSha}`, `STATUS: ${status}`, 'ROUTER_GENERATED: true', '', 'DETAILS:', ...details.map((l) => `- ${l}`), ''].join('\n');
  return { body, messageId };
}

/** Message ids that a router reply already answered, read from the comment history itself (survives lost local state and runner restarts). */
export function answeredMessageIds(all: readonly GhComment[], allowedLogins: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const c of all) {
    // A forged "router reply" from an untrusted author must not be able to mark a real message as already handled.
    if (!isTrustedAuthor(c, allowedLogins)) continue;
    const p = parseHandoff(c.body);
    // A router reply, or any trusted-author PONG/ROUTER_ACK/REVIEW_RESPONSE, answers the message it names.
    if (p.ok && p.handoff.inReplyTo && (p.handoff.routerGenerated || p.handoff.from === ROUTER_ID || ['PONG', 'ROUTER_ACK', 'REVIEW_RESPONSE'].includes(p.handoff.type))) out.add(p.handoff.inReplyTo);
  }
  return out;
}

export interface RouterStateFile {
  schema: 'agentic.router-cursor/1'; pr: number; lastCommentId: number;
  processed: Record<string, { commentId: number; action: Action; at: string }>;
}
export interface RouterGithub { prHeadSha(): string; listComments(): GhComment[]; postComment(body: string): { id: number; url: string; createdAt: string } }

export class RouterStore {
  private readonly dir: string;
  private readonly pr: number;
  constructor(dir: string, pr: number) { this.dir = dir; this.pr = pr; mkdirSync(dir, { recursive: true }); }
  load(): RouterStateFile {
    try {
      const s = JSON.parse(readFileSync(join(this.dir, 'cursor.json'), 'utf8')) as RouterStateFile;
      if (s.schema === 'agentic.router-cursor/1' && s.pr === this.pr && Number.isSafeInteger(s.lastCommentId) && s.processed && typeof s.processed === 'object') return s;
    } catch { /* first run or unreadable: start from the beginning; idempotency still holds via the comment history */ }
    return { schema: 'agentic.router-cursor/1', pr: this.pr, lastCommentId: 0, processed: {} };
  }
  save(s: RouterStateFile): void {
    const keys = Object.keys(s.processed);
    if (keys.length > MAX_PROCESSED) for (const k of keys.slice(0, keys.length - MAX_PROCESSED)) delete s.processed[k];
    const tmp = join(this.dir, 'cursor.json.tmp');
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, join(this.dir, 'cursor.json'));
  }
  append(file: 'review-queue' | 'inbox' | 'router-log', row: unknown): void { appendFileSync(join(this.dir, `${file}.jsonl`), `${JSON.stringify(row)}\n`); }
}

export interface RouteResult { commentId: number; url: string; action: Action; reason: string; messageId?: string; replyUrl?: string; replyCommentId?: number; latencySeconds?: number }

/**
 * Processes comments newer than the cursor (or exactly `onlyCommentId`, for event mode). Each comment is handled at most once:
 * a message id already answered in the PR history, or recorded in the cursor, is skipped. The cursor only advances past a
 * comment after its effects were durably recorded.
 */
export function routeComments(gh: RouterGithub, store: RouterStore, options: { allowedLogins: readonly string[]; now?: () => Date; onlyCommentId?: number; post?: boolean }): RouteResult[] {
  const now = options.now ?? (() => new Date());
  const post = options.post ?? true;
  const state = store.load();
  const all = gh.listComments();
  const prHeadSha = gh.prHeadSha();
  if (!SHA40.test(prHeadSha)) throw new Error('router: PR head SHA from GitHub is not a 40-hex commit');
  const handled = new Set<string>([...answeredMessageIds(all, options.allowedLogins), ...Object.keys(state.processed)]);
  const pending = all.filter((c) => options.onlyCommentId !== undefined ? c.id === options.onlyCommentId : c.id > state.lastCommentId).sort((a, b) => a.id - b.id);
  const results: RouteResult[] = [];
  for (const c of pending) {
    const d = decide(c, { prHeadSha, allowedLogins: options.allowedLogins, handled });
    const result: RouteResult = { commentId: c.id, url: c.url, action: d.action, reason: d.reason };
    const reply = renderRouterReply(d, c, prHeadSha);
    if (reply && post) {
      const posted = gh.postComment(reply.body);
      result.messageId = reply.messageId; result.replyUrl = posted.url; result.replyCommentId = posted.id;
      result.latencySeconds = Math.round((Date.parse(posted.createdAt) - Date.parse(c.createdAt)) / 1000);
      handled.add(reply.messageId);
    }
    // A dry run reports what would happen and changes nothing: no post, no cursor, no queue, no log.
    if (!post) { results.push(result); continue; }
    if (d.handoff && d.action !== 'ignore') {
      handled.add(d.handoff.messageId);
      state.processed[d.handoff.messageId] = { commentId: c.id, action: d.action, at: now().toISOString() };
    }
    const row = { at: now().toISOString(), ...result, from: d.handoff?.from, to: d.handoff?.to, type: d.handoff?.type, claimedMessageId: d.handoff?.messageId, headSha: d.handoff?.headSha, shaCurrent: d.shaCurrent };
    if (d.action === 'queue-review') store.append('review-queue', row);
    if (d.action === 'inbox') store.append('inbox', row);
    store.append('router-log', row);
    if (options.onlyCommentId === undefined) state.lastCommentId = Math.max(state.lastCommentId, c.id);
    store.save(state);
    results.push(result);
  }
  return results;
}
