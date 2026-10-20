// Deterministic AGENT_HANDOFF_V1 comment router for a pull request (no LLM). See docs/operations/agent-handoff-router.md.
//
//   npm run pr-router -- once  [--pr 53] [--dry-run]
//   npm run pr-router -- poll  [--pr 53] [--interval 300] [--max-minutes 120] [--exit-on-lead-message]
//   npm run pr-router -- event            (GitHub Actions: reads the issue_comment event from GITHUB_EVENT_PATH)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../src/core/paths.ts';
import { routeComments, RouterStore, type GhComment, type RouterGithub } from '../src/lead/collaboration/handoff-router.ts';

const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
const arg = (name: string, fallback?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const mode = process.argv[2] ?? 'once';

const repo = process.env.GITHUB_REPOSITORY ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('router: unexpected repository name');

let pr = Number(arg('pr', '53'));
let onlyCommentId: number | undefined;
if (mode === 'event') {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as { action?: string; issue?: { number: number; pull_request?: unknown }; comment?: { id: number } };
  if (event.action !== 'created' || !event.issue?.pull_request || !event.comment) { console.log(JSON.stringify({ skipped: 'not a created comment on a pull request' })); process.exit(0); }
  pr = event.issue.number; onlyCommentId = event.comment.id;
}
if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('router: invalid --pr');

const root = findProjectRoot() ?? process.cwd();
const store = new RouterStore(join(root, '.workdir', 'coordination', `pr-${pr}`), pr);
const allowedLogins = (process.env.AGENT_ROUTER_ALLOWED_LOGINS ?? (mode === 'event' ? process.env.GITHUB_REPOSITORY_OWNER ?? '' : gh(['api', 'user', '--jq', '.login']).trim())).split(',').map((s) => s.trim()).filter(Boolean);
if (!allowedLogins.length) throw new Error('router: no authorized login configured');

const client: RouterGithub = {
  prHeadSha: () => gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']).trim(),
  listComments: () => gh(['api', '--paginate', `repos/${repo}/issues/${pr}/comments?per_page=100`, '--jq', '.[] | {id, body, login: .user.login, association: .author_association, createdAt: .created_at, url: .html_url}'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as GhComment),
  postComment: (body) => {
    const file = join(root, '.workdir', 'coordination', `pr-${pr}`, 'outgoing.md');
    writeFileSync(file, body);
    return JSON.parse(gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-F', `body=@${file}`, '--jq', '{id, url: .html_url, createdAt: .created_at}'])) as { id: number; url: string; createdAt: string };
  },
};

const pass = (): number => {
  const results = routeComments(client, store, { allowedLogins, post: !flag('dry-run'), ...(onlyCommentId !== undefined ? { onlyCommentId } : {}) });
  for (const r of results) console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
  return results.filter((r) => r.action === 'inbox').length;
};

if (mode === 'once' || mode === 'event') { pass(); }
else if (mode === 'poll') {
  const intervalMs = Math.max(60, Number(arg('interval', '300'))) * 1000;
  const deadline = Date.now() + Math.min(Number(arg('max-minutes', '120')), 240) * 60_000;
  let failures = 0;
  while (Date.now() < deadline && failures < 5) {
    try { const toLead = pass(); failures = 0; if (toLead > 0 && flag('exit-on-lead-message')) { console.log(JSON.stringify({ exit: `message for the lead: .workdir/coordination/pr-${pr}/inbox.jsonl` })); break; } }
    catch (error) { failures += 1; console.error(JSON.stringify({ poll_error: (error as Error).message.slice(0, 200), failures })); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.log(JSON.stringify({ poll_ended: new Date().toISOString(), failures }));
} else throw new Error(`router: unknown mode ${mode}`);
