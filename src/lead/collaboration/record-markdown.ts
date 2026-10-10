import type { MeetingRecord, Source } from '../../runtime/collaboration/record.ts';

/**
 * Human-readable rendering of a stored meeting record (for review packs and handoffs). It adds no judgement: every line is
 * a field of the record, and every contribution carries its `[seq/messageId]` link back to the event stream. The words
 * "consensus" or "agreed by all" appear only for an agreement the record marks unanimous.
 */

const link = (s: Source) => `[${s.seq}/${s.messageId}]`;
const quote = (text: string) => text.replace(/\s+/g, ' ').trim();

export function renderMeetingRecord(r: MeetingRecord): string {
  const out: string[] = [];
  const section = (title: string, lines: string[], empty: string) => out.push(`## ${title}`, '', ...(lines.length ? lines : [empty]), '');

  out.push(`# Meeting record: ${r.title}`, '');
  out.push(`- Session \`${r.sessionId}\` in thread \`${r.threadId}\`${Object.keys(r.refs).length ? ` (${Object.entries(r.refs).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  out.push(`- Outcome: **${r.outcome}** (${r.reason})`);
  out.push(`- Chair: ${r.chair}; participants: ${r.participants.map((p) => `${p.id} (${p.role})`).join(', ')}`);
  out.push(`- Usage: ${r.usage.roundsStarted}/${r.limits.maxRounds} round(s), ${r.usage.invocations}/${r.limits.maxInvocations} invocation(s), tokens ${r.usage.tokens}${r.limits.maxTokens ? `/${r.limits.maxTokens}` : ''}`);
  out.push(`- Provenance: through event ${r.provenance.throughSeq} (\`${r.provenance.throughHash.slice(0, 16)}\`), record \`${r.recordHash.slice(0, 16)}\``, '');

  section('Agenda', r.agenda.map((a, i) => `${i + 1}. ${a}`), '(none)');
  section(
    'Alternatives',
    r.alternatives.map((a) => `- ${link(a.source)} **${a.status}** by ${a.author}: ${quote(a.body)}${a.supporters.length ? ` — supported by ${a.supporters.join(', ')}` : ''}${a.outstandingObjections.length ? ` — outstanding objections ${a.outstandingObjections.join(', ')}` : ''}${a.correctedBy.length ? ` — corrected by ${a.correctedBy.join(', ')}` : ''}`),
    '(no proposal)',
  );
  section('Objections', r.objections.map((o) => `- ${link(o.source)} **${o.status}** ${o.author} on ${o.target}: ${quote(o.body)}`), '(none)');
  section('Questions', r.questions.map((q) => `- ${link(q.source)} **${q.status}** ${q.author}: ${quote(q.body)}${q.answers.length ? ` — answered by ${q.answers.join(', ')}` : ''}`), '(none)');
  section(
    'Agreements',
    r.agreements.map((a) => `- ${a.proposalId}: ${a.unanimous ? 'agreed by all other participants' : `supported by ${a.supporters.join(', ')} (not unanimous)`} ${a.sources.map(link).join(' ')}`),
    '(no explicit support was given)',
  );
  section(
    'Decisions',
    r.decisions.map((d) => `- ${link(d.source)} ${d.decider}: **${d.outcome}** ${d.proposalIds.join(', ')} — ${quote(d.rationale)}${d.contested ? ` — CONTESTED, overruled objections ${d.overruledObjections.join(', ')}` : ''} (grants no authority)`),
    '(no decision)',
  );
  section('Action items', r.actionItems.map((a) => `- [ ] ${a.owner}: ${quote(a.description)} (from ${a.decisionId} ${link(a.source)})`), '(none)');
  section('Unresolved', r.unresolved.map((u) => `- ${link(u.source)} ${u.kind} ${u.id}: ${u.detail}`), '(nothing left open)');
  section('Corrections', r.corrections.map((c) => `- ${link(c.source)} ${c.author} corrects ${c.target}: ${quote(c.body)}`), '(none)');
  section(
    'Turns',
    r.turns.map((t) => `- r${t.round}.t${t.turn} a${t.attempt} ${t.participant}: ${t.outcome}${t.kind ? ` ${t.kind}` : ''}${t.messageId ? ` ${t.messageId}` : ''}${t.reason ? ` — ${quote(t.reason)}` : ''} (event ${t.seq})`),
    '(no turn was taken)',
  );
  if (r.pendingAtEnd) out.push(`In flight when the session ended: r${r.pendingAtEnd.round}.t${r.pendingAtEnd.turn} ${r.pendingAtEnd.participant} (charged, never answered).`, '');
  return out.join('\n');
}
