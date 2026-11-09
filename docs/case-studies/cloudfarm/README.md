# Case study: CloudFarm

CloudFarm (`anvh2/cloudfarm`, private) is a software-first farm management platform built end to end with Agentic
Engineering. It is a real product and the reference case study of this platform: every discussion, decision, mission,
run, review and verification result is meant to be traceable from the human's request to the merged code, under
`project_id=cloudfarm`.

## Roles

| Role | Who | Owns |
| --- | --- | --- |
| Technical Architect | the human | product direction, architecture approval, security/cost/visibility decisions, merges to `master` |
| Engineering Lead | Claude (this platform's Lead) | discovery, HLD/ADRs, issues, missions, worker assignment, review coordination, reporting |
| Coding workers | local Qwen via Ollama (preferred), others by operator allow-list | approved, scoped implementation tasks |
| Runtime | this repository | mutation boundaries, verification, PASS/FAIL, retries, escalation, integration |

## Documents

| Document | Content |
| --- | --- |
| [kickoff-brief.md](kickoff-brief.md) | The original request, verbatim |
| [DISCOVERY.md](DISCOVERY.md) | Workspace and platform discovery (2026-11-09) |
| [WORKSPACE.md](WORKSPACE.md) | Project registration, repository setup, source-of-truth boundaries |
| [MASTRA-WORKFLOW.md](MASTRA-WORKFLOW.md) | Discussion → issue → mission → execution → review flow, and what is not built yet |
| [EVIDENCE.md](EVIDENCE.md) | Evidence contract and the ledger of recorded evidence |
| [DEMO-RUNBOOK.md](DEMO-RUNBOOK.md) | How to show the case study in Studio on port 4111 |

CloudFarm's own product and architecture documents live in the CloudFarm repository (`docs/`), not here.

## Status (2026-11-09)

| Capability | Status | Evidence |
| --- | --- | --- |
| CloudFarm GitHub repository | **Verified** | private, default `master`, squash/rebase merge disabled ([EVIDENCE](EVIDENCE.md) E2) |
| Project registered in Agentic Engineering | **Verified** | `agentic.project/1` record + scheduler batch `CF-M0` with `project=cloudfarm` (E4, E5) |
| CloudFarm visible in Studio 4111 | **Verified (data path)** | 4111 gateway returns the `cloudfarm` scope, its missions and events (E8); not visually screenshot-tested |
| Milestones and issues | **Verified** | 2 milestones, 12 issues, created once with a duplicate guard (E3) |
| Missions linked to issues | **Partially implemented** | by task title prefix `anvh2/cloudfarm#N` only; no structured link field |
| GitHub → Mastra issue synchronization | **Proposed** | design in [MASTRA-WORKFLOW](MASTRA-WORKFLOW.md#proposed-github-link-and-sync); not built |
| Discovery and architecture baseline | **Verified by runtime, awaiting review** | mission `CF-M0.gh1` DONE with integration verifier exit 0; PR anvh2/cloudfarm#13 open for the Architect (E6, E7) |
| Discussion record | **Implemented** (as a document) | `docs/discussions/2026-11-09-kickoff.md` in CloudFarm; no Studio discussion thread yet |
| Studio-visible meeting | **Blocked** | `lead meeting open` needs a model-backed participant; Ollama is not running |
| Local worker (Qwen) execution | **Blocked** | Ollama not running; no implementation task specified yet |
| First vertical slice (code) | **Proposed** | M1 issues #6–#11, gated by Architect decisions (#2) and go-kit fixes (#4, #12) |
| CI | **Not started** | CloudFarm #5 |
