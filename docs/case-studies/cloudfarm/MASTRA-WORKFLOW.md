# Workflow: discussion → issue → mission → execution → review

## The flow, and what exists today

| # | Step | Mechanism | Status |
| --- | --- | --- | --- |
| 1 | Human and Lead discuss (Vietnamese or English) | Chat with the Lead | Works |
| 2 | Record the discussion and decisions | CloudFarm `docs/discussions/<date>-<topic>.md` (English, original quoted when useful), merged by PR | Implemented (document); a Studio-visible thread needs step 3 |
| 3 | Hold or record a meeting | `npm run lead -- meeting open <id> --batch <CF batch> ...` (thread refs validated against the scheduler, so Studio attributes it to `cloudfarm`) | **Blocked**: needs one model-backed participant; Ollama is down |
| 4 | Extract decisions, requirements, questions, actions | Lead writes PRD/ADR changes and decision IDs (D-NNN) | Works |
| 5 | Lead validates scope | Acceptance criteria and dependencies on each issue | Works |
| 6 | Lead creates or updates GitHub issues | `gh issue create/edit` with labels and milestones; creation guarded against duplicates | Works (manual guard) |
| 7 | Mastra shows GitHub issues | — | **Not built** (see the proposal below) |
| 8 | Lead creates missions linked to issues | `npm run lead:plan -- <plan.json>` with `project: "cloudfarm"`; task title prefix `anvh2/cloudfarm#N` | Partially implemented: link by convention only |
| 9 | Execute | Lead-owned: `lead claude start/done`; workers: `lead:run` → Mastra `coding-task-workflow` | Lead path verified (`CF-M0.gh1`); worker path blocked (Ollama) |
| 10 | Independent review and verification | Runtime integration commands / sandboxed verifier → PASS/FAIL; `lead review decide`; Architect PR review | Runtime verifier verified; PR review pending (#13) |

## Language

The human may speak Vietnamese. The Lead writes the English canonical artifact and preserves meaning; when wording
matters, the discussion record quotes the original next to the English summary. Issues, ADRs, PRDs, PRs and commits are
English only.

## Mission conventions (interim)

- Task ID `CF-<milestone>.gh<issue>` (plus a suffix for re-plans, e.g. `CF-M1.gh9b`).
- Task title starts with `anvh2/cloudfarm#<issue>`.
- Lead-owned tasks carry `keptReason` explaining why no local worker is used; this is the recorded model-routing
  decision.
- Commits and PR descriptions name the mission ID; PRs reference the issue (`Closes #N` / `Refs #N`).

The convention is readable by people but the Control Center deliberately does not match records by name (M13 rule), so
Studio does not yet show the link as data.

## Proposed: GitHub link and sync

The smallest change that fits the existing architecture. It is a platform change on `master` and needs its own review,
and becomes visible on 4111 only after a Studio rebuild handed off by the Studio's owner.

1. **Structured link on missions.** Add optional `links: [{ system: "github", repo: "anvh2/cloudfarm", kind: "issue" | "pull", number }]`
   to `taskSpecSchema`, validated, stored in the existing `tasks.spec` JSON. No table change; older readers ignore it.
2. **Read-only GitHub mirror.** `npm run lead -- github sync --project cloudfarm --repo anvh2/cloudfarm` reads issues,
   milestones and PRs through `gh api` and writes one snapshot (`.workdir/github/<owner>__<repo>.json`: `fetchedAt`,
   items keyed by number with title, state, URL, milestone, labels, `updatedAt`). Idempotent by construction: it never
   creates or edits GitHub records, and repeated syncs replace the snapshot.
3. **Gateway projection.** The Control Center adds the mirror to a project-scoped response: issues with their linked
   missions (by `links`, never by title), PR state, and the mirror's `fetchedAt` so staleness is visible.
4. **Studio.** A GitHub column on the Runs table and an issue list in the project overview, labelled with the sync time.

Ownership stays as in [WORKSPACE](WORKSPACE.md#source-of-truth-boundaries): GitHub writes only through the Lead's
`gh` actions, and Studio only displays them.
