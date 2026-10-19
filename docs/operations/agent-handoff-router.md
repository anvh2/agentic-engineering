# Agent handoff router (PR comment transport)

A deterministic, LLM-free router for `AGENT_HANDOFF_V1` comments on a pull request. It exists so the Engineering Lead and the
independent reviewer can exchange messages without the human relaying them, and without spending model tokens on polling.

Code: `src/lead/collaboration/handoff-router.ts` (pure logic + store), `scripts/pr-router.ts` (CLI), `.github/workflows/agent-handoff-router.yml` (event bridge).

## What it does, and what it never does

| It does | It never does |
| --- | --- |
| Parse only the fixed header block of a comment | Interpret, echo or execute comment text |
| Answer a valid `PING` with a `PONG` labelled `ROUTER_GENERATED` from `Router-Bridge` | Speak as a reviewer, or claim a reviewer saw anything |
| Queue `REVIEW_REQUEST` / `READY_FOR_REVIEW` for the reviewer's scheduled independent review | Approve, pass, merge, deploy or run a command |
| Copy messages addressed to the lead into a local inbox | Treat a comment as proof that a test passed |
| Compare the claimed `HEAD_SHA` with the PR head **fetched from GitHub** and flag a stale SHA | Trust a SHA, author or "router reply" claimed inside a comment |

## Validation order (each step can only reduce what happens next)

1. Protocol line `AGENT_HANDOFF_V1`, bounded size, strict header grammar, no duplicate headers, `HEAD_SHA` is 40 hex or `LOCAL_ONLY`.
2. Loop guard: anything `ROUTER_GENERATED`, from `Router-Bridge`, or of type `ROUTER_ACK` is ignored.
3. Author authentication: the GitHub login must be on the allow-list or have `OWNER`/`MEMBER`/`COLLABORATOR` association.
4. `FROM` and `TO` must be known agent ids.
5. Idempotency: a message id already answered in the PR history (by a trusted author's router reply, `PONG`, `ROUTER_ACK` or `REVIEW_RESPONSE`) or recorded in the cursor is skipped.
6. Only then the reaction table: `PING` → router `PONG`; review request to the reviewer → queue + `ROUTER_ACK`; message to the lead → inbox; anything else → recorded.

A forged "router reply" from an unauthorized author does not count as an answer, so it cannot suppress a real message.

## Known limitation: sender identity is not authenticated

All agents that post through the same GitHub account (observed on PR #53: Claude's and ChatGPT's comments are all authored by `anvh2`) are
indistinguishable to GitHub. The `FROM:` header is therefore a **claim**. The router authenticates the *account*, not the *agent*, and no
decision treats `FROM` as authority. Consequences:

- A message claiming to be from the reviewer is evidence of transport, not of review. Substantive findings are still verified against code and tests.
- If separate accounts or GitHub App identities are provisioned later, add the reviewer's login to a per-agent allow-list and make `FROM` binding to it.

## Transports

- **Event bridge (preferred, low latency):** `issue_comment.created` workflow. GitHub runs `issue_comment` workflows only from the default branch,
  so the file is inert until it is merged to `master`. That merge is a human decision; nothing here activates it. The job checks out only the default
  branch, never PR code, reads the event from `GITHUB_EVENT_PATH` (no `${{ }}` interpolation of comment text) and posts as `github-actions[bot]`,
  which is a distinct, honest identity. Runners are ephemeral, so the PR comment history is the durable record there.
- **Local poller (interim):** `npm run pr-router -- poll --pr 53 --interval 300 --exit-on-lead-message`. One `gh api` call per interval, no model call.
  It exits when a message addressed to the lead arrives, which is what wakes the lead session.

## Durable state (`.workdir/coordination/pr-<n>/`, gitignored)

`cursor.json` (last comment id + processed message ids, written atomically), `review-queue.jsonl`, `inbox.jsonl`, `router-log.jsonl`
(every decision with the comment URL, reply URL and observed latency). Losing the directory is safe: idempotency is re-derived from the PR comments.
`--dry-run` persists and posts nothing.

## Review queue semantics

A queued request means "recorded for the reviewer's next scheduled independent review". `QUEUED_STALE_SHA` means the pushed SHA moved since the request;
the reviewer should review the current head. Nothing in the queue is an approval.
