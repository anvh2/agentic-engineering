import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collabHarness, designMeeting, openMeeting } from '../../../runtime/collaboration/__testing__/harness.ts';

/**
 * Writes ONE deterministic fake-agent meeting (Core B's reference design meeting) into a NEW scheduler database, through
 * Core B's real CollaborationStore and MeetingCoordinator. Participants are Core B's scripted test identities
 * (provider 'fake'): no model, provider or network is called, and the UI labels the transcript as fake participants.
 *
 *   node src/integrations/control-center/__testing__/seed-collaboration-demo.ts <new.db> [--from <existing scheduler.db>]
 *
 * It refuses an existing target, so it can never write to a live scheduler database. `--from` first copies an existing
 * database with VACUUM INTO over a read-only connection (the source is never opened for writing).
 */
const args = process.argv.slice(2);
const fromAt = args.indexOf('--from');
const from = fromAt >= 0 ? args[fromAt + 1] : undefined;
const target = args.find((_, i) => fromAt < 0 || (i !== fromAt && i !== fromAt + 1));
if (!target || (fromAt >= 0 && !from)) throw new Error('usage: seed-collaboration-demo.ts <new.db> [--from <existing scheduler.db>]');
const path = resolve(target);
if (existsSync(path)) throw new Error(`refusing to write to an existing database: ${path}`);
if (from) {
  const source = new DatabaseSync(resolve(from), { readOnly: true });
  try {
    source.prepare('VACUUM INTO ?').run(path);
  } finally {
    source.close();
  }
}
const h = collabHarness({ path, turnTimeoutMs: 5_000 });
try {
  const { threadId, sessionId } = openMeeting(h.store);
  const result = await h.coordinator.run(sessionId, { owner: 'seed-collaboration-demo', participants: designMeeting().participants });
  if (result.status !== 'concluded') throw new Error(`meeting did not conclude: ${JSON.stringify(result).slice(0, 300)}`);
  const record = h.store.record(sessionId)!;
  console.log(JSON.stringify({ path, copiedFrom: from ? resolve(from) : null, threadId, sessionId, outcome: record.outcome, events: h.store.events(threadId).length, recordHash: record.recordHash }, null, 2));
} finally {
  h.scheduler.close();
}
