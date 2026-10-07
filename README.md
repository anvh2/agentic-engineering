# agentic-engineering

A local-first autonomous software-engineering runtime.

- **Human** — Chief Architect: sets goals, approves, overrides.
- **Claude** — Engineering Lead: plans work, reviews, escalates, integrates.
- **Scheduler** — owns persistent work (SQLite): claims, leases, retries, audit trail.
- **Local AI workers** (Qwen via Ollama) — implement tasks small enough to delegate.
- **Sandbox + worktrees** — every task runs in an isolated git worktree; model-generated code runs in an OS sandbox.
- **Deterministic verification** — only the harness's own test run can mark a task PASS; the model's word counts for nothing.
- **Integration** — approved tasks are merged into a `lead-integration/<batch>` branch and re-verified. Nothing is ever pushed, and the user's checkout is never touched.

Mastra, Ollama, Qwen, Claude and Trellis are integrations behind adapters. They are not the architecture.

## How a task flows (the one supported path)

```
Objective → Engineering Lead (Claude, `npm run lead -- plan`)
  → Scheduler (`src/runtime/scheduler`)         claim + lease + fencing
  → Executor (`src/integrations/mastra/executor`) one task → one workflow run
  → Coding workflow (Mastra, `coding-task-workflow`)
  → Coding runner (`src/runtime/execution`)     bounded attempts, mutation policy
  → Worker (`src/workers`)                      edits via guarded repository tools
  → Sandboxed verification (`src/runtime/sandbox`)
  → Review (deterministic change review + a recorded Lead decision)
  → Integration (`src/runtime/integration`)     merge, re-verify, roll back on failure
```

Details and guarantees: [docs/architecture/runtime.md](docs/architecture/runtime.md).

## Layout

```
src/
  core/             project-root discovery
  runtime/
    scheduler/      task model, lifecycle state machine, SQLite store, reports
    execution/      task contract, eligibility gate, coding runner, trace/artifacts
    sandbox/        macOS sandbox-exec wrapper (fails closed)
    worktree/       per-task git worktrees and the stale-base guard
    review/         deterministic change review
    integration/    merge + verification + rollback
    capacity/       machine-wide limit on concurrent local-model (Ollama) calls
    repository/     target-repository validation and ecosystem detection
  workers/          Qwen coding workers and their guarded tools
  lead/             review packs/decisions (`review.ts`), session checkpoints (`session/`)
  integrations/
    mastra/         Mastra app: workflow adapter, server entry, metrics route
    trellis/        optional Trellis context for target repos
    video/          eShop video pipeline (product integration, see below)
  observability/    Prometheus metrics, scheduler-state reader
scripts/            supported CLI entrypoints only
projects/           per-project config and lead-owned state (`projects/<name>/`)
docs/               architecture, operations, plans, audits
tests/              benchmark fixtures and runner (Go ladder)
.workdir/           local runtime state (gitignored): scheduler DB, worktrees, artifacts
```

## Quick start

Requirements: Node ≥ 22.13, git, Ollama with the worker model (`OLLAMA_MODEL`, default `qwen3:8b`), macOS for the sandbox, and Go/Node toolchains for the target repository.

```shell
npm install
cp .env.example .env
npm run dev                      # Mastra server + Studio on :4111 (needed for `lead run`)
```

## Commands

```shell
npm run lead -- plan <plan.json>               # create a batch (tasks → BACKLOG/READY)
npm run lead -- tasks [--batch B] [--state S]
npm run lead -- run [--batch B] [--workers N]  # needs `npm run dev`
npm run lead -- status [--batch B]
npm run lead -- review list | pack | decide <task> approve|reject|escalate --feedback "..."
npm run lead -- integrate <batch>
npm run lead -- resume [--steal] [--run]       # recover expired leases / interrupted integrations
npm run lead -- cancel <task>
npm run session -- checkpoint|resume|status <project>   # lead session checkpoints (projects/<name>)
npm run typecheck
npm test                                       # unit tests
npm run test:integration                       # ffmpeg etc.; needs local tools
npm run bench:go                               # worker capability ladder (uses Ollama)
```

`npm run lead:<verb>` aliases exist for each verb (`lead:plan`, `lead:run`, …).

## Video pipeline (eShop product integration)

`src/integrations/video/` and `scripts/video-transform.ts` are the local video-transformation pipeline that the eShop admin calls as a child process. It is not part of the engineering runtime and is slated to move into the eShop repository. The eShop locates it through `VIDEO_PIPELINE_DIR`; see [docs/operations/video-transformation.md](docs/operations/video-transformation.md).

## More

- [AGENTS.md](AGENTS.md) — rules for AI agents working in this repo
- [docs/architecture/runtime.md](docs/architecture/runtime.md) — lifecycle, guarantees, delegation eligibility
- [docs/plans/vision.md](docs/plans/vision.md) — long-term target
- [docs/audits/](docs/audits/) — reliability audit (2026-10-06) and evidence
