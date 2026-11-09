# Discovery (2026-11-09)

What was actually found by inspecting repositories, processes and source code, before anything was changed.

## Repositories

| Path | Role | State at discovery |
| --- | --- | --- |
| `anvh2/agentic-engineering` (this repo) | Platform | Branch `master` at `9b2dcd9`, tracking `origin/master`, clean. 30+ linked worktrees from earlier sessions (left untouched). |
| `../cloudfarm` | CloudFarm checkout | Existed as an **empty, non-git directory** (created 2026-11-09 21:51 local). No remote `anvh2/cloudfarm` on GitHub. |
| `anvh2/go-kit` | Backend kit (Architect's) | Packages: `log` (zap), `server` (gRPC + grpc-gateway over cmux, recovery/prometheus/validator interceptors), `cache`, `client/http`, `queue/delay`, `builtin/errors`, `proto` (buf config). **No database layer.** Untracked work under `foundation/` (preserved). |
| `vus-pm-gw` | Style reference | urfave/cli commands; `internal/{handler,service/<domain>,store,models,pkg}`; GORM + `goqueryset` generated query sets; numbered SQL migrations; root `pkg/` (CloudFarm will not copy that). |
| `vus-proto` | Proto conventions | Buf v1 + `buf.work.yaml`, managed mode, `grpc/go`, `protocolbuffers/go`, `gateway` v2, `validate-go`, `openapiv2`; one directory per service. |
| `vus-go-kit` | Not to be imported | GORM helpers (`log/gormlogr`, `tracing/gormotel`) and generated query builders; candidates to adapt into go-kit (CloudFarm #4). |

## Studio on port 4111

- Listener: `node` PID 90405 on `127.0.0.1:4111`, started 2026-11-07 by `node studio-fork/start.mjs` (parent PID 90403)
  in **`.worktrees/studio-master`**, a detached worktree at `bb01119`.
- `bb01119` is an ancestor of `master` (`9b2dcd9`); `src/`, `apps/` and `studio-fork/` are identical between them, so the
  running Studio runs current platform code. Any new platform code needs a Studio rebuild, which is an
  owner-controlled handoff (AGENTS.md).
- Its gateway reads the **canonical scheduler database** (`AGENTIC_SCHED_DB=<repo>/.workdir/scheduler/scheduler.db`);
  its Mastra trace storage is isolated (`.worktrees/studio-master/.workdir/control-center-runtime/mastra.db`).
- Registered workflows include `coding-task-workflow`; agents include `coding-worker-go`.

## Platform mechanisms found

| Need | Existing mechanism | Location |
| --- | --- | --- |
| Project identity | `agentic.project/1` record: repo path, `identity.rootCommit`, test command | `.workdir/projects/<name>/project.json`; `src/lead/session/project.ts` (precedent: `eshop`) |
| Project scope in Studio | scheduler `batches.project`; gateway `?project=`; Studio "Project" selector | `src/integrations/control-center/adapter.ts`, `apps/control-center/src/main.tsx` |
| Missions/tasks | Scheduler batches and tasks with an enforced lifecycle | `src/runtime/scheduler`, `npm run lead:plan` |
| Lead-owned work | `executor: "claude"` tasks with `keptReason`; `lead claude start/done` verified by batch integration commands | `src/lead/review.ts`, `src/runtime/integration/integrate.ts` |
| Worker execution | Mastra `coding-task-workflow` → coding runner → sandboxed verifier | `docs/architecture/runtime.md` |
| Discussions/meetings | Collaboration store in the scheduler DB; `lead meeting open/run/record`; refs validated against batches/tasks | `src/runtime/collaboration`, `src/lead/collaboration/meeting-cli.ts` |
| GitHub | `gh` authenticated as `anvh2` (scopes `repo`, `workflow`, `project`, `read:org`, `gist`); only use is the PR comment router | `scripts/pr-router.ts` |
| Issue synchronization | **None.** No code reads GitHub issues; tasks have no external-reference field (`taskSpecSchema` strips unknown keys) | — |
| Integration command policy | Only `go`, `gofmt` and validated `npx` | `integrate.ts` `validateCommand` |

## Environment

Go 1.25.10, Buf 1.66.0, protoc 3.21.12, Node 22.23.2, pnpm present, PostgreSQL 15.4 accepting connections on
`/tmp:5432`. **Missing or down:** Flutter/Dart (not installed), Ollama (not running, so no local Qwen worker), Docker
daemon (not running).

## Findings that shaped the plan

1. **go-kit silently ignores custom gRPC interceptors and server options** (`WithGRPCUnaryInterceptor`,
   `WithGRPCStreamInterceptor` and `WithGRPCServerOptions` are stored but `grpcServe` never reads them). An authorization
   interceptor would not run, so authorization would fail open. Filed as anvh2/cloudfarm#12.
2. go-kit has no GORM/queryset support; it must be added before CloudFarm's data layer (anvh2/cloudfarm#4).
3. The previous local-worker experiment (2026-10-27) showed qwen3:8b needing 6–15 minutes per call and failing to write
   files on multi-file Go work; CloudFarm tasks for local workers must be single-file and small.

## Interpretations of the brief (for the Architect to confirm)

- **"Do not create a worktree"** is read as: no development worktree, fork or clone created by the Lead. The runtime's
  own managed worktrees (`.workdir/worktrees/<batch>/...`, e.g. `CF-M0/_integration`) are part of its isolation and
  safety model, which AGENTS.md forbids weakening; CloudFarm missions use them.
- **Documentation location:** `docs/case-studies/cloudfarm/` as the brief requests. AGENTS.md listed four doc
  directories; this commit adds `case-studies` to that list rather than filing the case study under `audits/`.
- **Branch:** CloudFarm also uses `master` as its default branch, for consistency with the platform.
