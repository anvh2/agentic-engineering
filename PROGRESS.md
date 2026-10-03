# Coding Worker Harness — Build Log

Running log of the autonomous-coding-worker build, kept step-by-step for
maintainability. Each entry covers what was built, why, and how it was
verified. Steps 1–8 predate this log (see note below); everything from
Step 9 onward is recorded here as it happens.

## Current status — 2026-09-27

**Active project:** raw product photos → 15-second vertical affiliate
marketing video with generated scenes/keyframes.

**Required order:** Phase 0 → Phase 2 → Phase 3 → Phase 4 → explicit user
approval of the actual video and architecture → Phase 1 → Phase 5 → Phase 6.

| Phase | Status | Result / gate |
|---|---|---|
| Phase 0 — isolated reference/control benchmark | **COMPLETE** | Real 15-second raw-photo control video rendered and measured on Apple M2 / 16 GiB. Current AnimateDiff profile failed the conservative memory gate. This output is a technical fallback/reference, not the intended product quality target. |
| Phase 2 — product reference pack + fallback renderer | **COMPLETE** | Standalone CLI emitted hashed/decoded source evidence, a five-scene generated-marketing brief, a reference board, and a valid 15s fallback/control MP4. No production job, database or UI integration. |
| Phase 3 — essential ComfyUI marketing keyframe/scene generation | **CATVTON REJECTED; NEXT LOCAL PROFILE REQUIRED** | C3 completed locally but lost sleeves, silhouette, chest construction and buttons despite valid person/garment preprocessing and broad repaint coverage. Further mask tuning/C4 was rejected as speculative. OpenAI is guidance-only; rendering remains local ComfyUI. |
| Phase 4 — ComfyUI local AI motion benchmark | **NOT STARTED** | Applies only if it improves accepted generated scenes without fidelity loss. LTX weights are absent; the existing AnimateDiff M2 trial hit the resource gate and is not approved as the default renderer. Its heavy M2 cost is a primary benchmark criterion. |
| User review gate | **PENDING** | Final Phase 2–4 generated-scene video quality and architecture must be explicitly approved before integration. The Phase 0 baseline is an early technical reference, not this final gate. |
| Phase 1 — durable jobs/database | **DEFERRED** | Must not start before the user review gate. |
| Phase 5 — workspace UI | **DEFERRED** | Must not start before the user review gate and Phase 1 contracts. |
| Phase 6 — production hardening | **DEFERRED** | Must not start before production integration. |

**Phase 0 artifacts:**

- Review video: [`benchmarks/phase0/run-01/baseline-15s.mp4`](benchmarks/phase0/run-01/baseline-15s.mp4)
- Visual summary: [`benchmarks/phase0/run-01/contact-sheet.jpg`](benchmarks/phase0/run-01/contact-sheet.jpg)
- Results and limitations: [`benchmarks/phase0/RESULTS.md`](benchmarks/phase0/RESULTS.md)
- Reproduction instructions: [`benchmarks/phase0/README.md`](benchmarks/phase0/README.md)
- Revised architecture and phase order: [`ARCHITECTURE_REASSESSMENT.md`](ARCHITECTURE_REASSESSMENT.md)

**New Phase 2/3 review artifacts:**

- Phase 2 source-evidence board: [`benchmarks/phase2/run-01/reference-board.jpg`](benchmarks/phase2/run-01/reference-board.jpg)
- Phase 2 fallback/control video: [`benchmarks/phase2/run-01/fallback-control-15s.mp4`](benchmarks/phase2/run-01/fallback-control-15s.mp4)
- Phase 3 generated-scene review video: [`benchmarks/phase3/run-01/generated-scene-review-15s.mp4`](benchmarks/phase3/run-01/generated-scene-review-15s.mp4)
- Phase 3 generated-scene contact sheet and decisions: [`benchmarks/phase3/run-01/generated-scene-review-contact-sheet.jpg`](benchmarks/phase3/run-01/generated-scene-review-contact-sheet.jpg) · [`benchmarks/phase3/RESULTS.md`](benchmarks/phase3/RESULTS.md)
- Phase 3B CatVTON stop decision: [`benchmarks/phase3b/CONCLUSION.md`](benchmarks/phase3b/CONCLUSION.md)

**Measured Phase 0 outcome:** 15.000 seconds, 1080×1920, 30 fps, 450
decoded frames; full decode passed; 36.49-second render wall time; highest
measured FFmpeg subprocess RSS approximately 759 MiB. One real
384×512/16-frame AnimateDiff+IPAdapter trial was interrupted after about 60
seconds when system swap rose from roughly 2.0 GiB to 4.9 GiB. It produced no
usable clip. This is a resource-gate rejection under the observed machine
load, not proof of OOM or of all local video models being infeasible.

**Known quality limits awaiting improvement/review:** only one blouse and
three photos were benchmarked; the deterministic video repeats raw catalog
views, is silent, and retains source hands, props, decorative symbols and
original lighting. This does not satisfy the corrected product goal by itself:
the intended video should look like newly generated marketing content from
product references, ideally with a believable wearer/reviewer scene, or else a
premium product-commercial scene. Printed/logo and fine-lace fixtures, cloud
scene generation, LTX, music, segmentation and a reusable standalone reference
pack/fallback renderer remain untested or unimplemented.

**Production integration status:** no affiliate-video PostgreSQL tables,
durable worker, workspace UI, recovery flow or production API changes were
implemented by Phase 0.

## Steps 1–8 (prior to this log)

Base Mastra scaffold from `create-mastra` (general-purpose agent, workspace
tools, memory, schedules — see `README.md`) plus the initial supervisor →
workflow → worker skeleton. Not itemized here since this log started at
Step 9; consult `git log` / the repo state for specifics.

## Step 9 — Repository-aware, read-only coding worker

**Goal:** give a local Ollama-backed worker sandboxed, read-only access to
inspect a real repository, orchestrated by a Claude Pro supervisor.

**Built:**
- [`src/mastra/supervisor/claude-supervisor.ts`](src/mastra/supervisor/claude-supervisor.ts) — shells out to the local `claude` CLI (`-p`, non-interactive, JSON structured output) to turn a free-form request into a typed `CodingDelegation`. `repository` always comes from the caller, never the model's own output.
- [`src/mastra/workflows/coding-task-workflow.ts`](src/mastra/workflows/coding-task-workflow.ts) — single-step Mastra workflow: takes a `CodingDelegation`, puts the repository root into a `RequestContext`, and runs `codingWorker`.
- [`src/mastra/agents/coding-worker.ts`](src/mastra/agents/coding-worker.ts) — Ollama-backed agent (`qwen3:8b` by default) with strict grounding instructions (must `readFile` real files before making claims).
- [`src/mastra/tools/repository-tools.ts`](src/mastra/tools/repository-tools.ts) — `listFiles`/`readFile`/`searchFiles`, read-only, path-escape protected via `path.relative`-based boundary checking.
- Demo scripts: `npm run worker:demo`, `npm run workflow:demo`, `npm run supervisor:demo`.

**Verified:** end-to-end against the real `vus-metadata-v2` repository.

## Step 10 — Repository sandbox hardening

**Goal:** make the read sandbox trustworthy before any write capability is
introduced.

**Built:**
- Symlink-aware boundary check: `resolveWithinRepository` became async and now resolves the *real* filesystem target via a symlink-tolerant `realpath` walk (`realpathTolerant`), rejecting any path whose real target lands outside the repository root — not just string/`../` traversal. Handles nonexistent paths, broken symlinks, and nested symlinks.
- `listFiles` reports symlink entries with an explicit `type: 'symlink'` rather than resolving/traversing them. `searchFiles`'s recursive walk was confirmed (and tested) to never follow symlinks, since Node's `Dirent.isDirectory()`/`isFile()` reflect the directory entry itself, not the symlink target.
- `readFile` truncation is now communicated directly in the returned `content` string (not just a boolean field), with exact byte counts, so a model skimming only the text can't mistake truncated output for the complete file.
- `searchFiles` gained a `notice` field explaining *why* results are incomplete (hit the match cap vs. the file-scan cap).
- Filesystem errors (permission failures, etc.) are caught and converted to generic messages — never leak absolute host paths to the model.
- New test files: `repository-symlink-security.test.ts`, `repository-tools-limits.test.ts`, `coding-task-workflow.test.ts` (workflow-context wiring tested by stubbing only `codingWorker.generate` — the real workflow engine runs unmodified, no Ollama/Claude dependency in the automated suite).
- Confirmed via grep: zero module-level mutable state: repository identity flows exclusively through `RequestContext`.

**Verified:** 40/40 tests passing, `tsc --noEmit` clean, all three demos still work (including `supervisor:demo` against the real repo).

**Known residual risk (documented, not fixed):** the `realpath` check and
the actual file access aren't atomic — a TOCTOU window exists if a symlink
is swapped between check and use. Acceptable for the current single-user
local-CLI threat model; flagged for revisit before durable/concurrent
execution.

## Step 11 — Controlled repository write access

**Goal:** give the worker a single, tightly bounded write capability without
weakening any of Step 10's read-side guarantees.

**Built:**
- `applyPatch` (`src/mastra/tools/repository-tools.ts`) — applies a single-file unified diff (via the `diff` npm package) or creates a new file, and returns the resulting diff. Strict context matching (`fuzzFactor: 0`) means a patch generated against stale content simply fails to apply rather than being force-applied — this is what makes "stale patches are rejected" true, with no separate versioning/staleness token needed.
- `resolveWritablePathWithinRepository` — a stricter sibling of the read-side boundary check: it rejects *any* symlink anywhere between the repository root and the target, even one whose real target resolves inside the repository (reads tolerate internal symlinks; writes don't, closing the TOCTOU window entirely for the one operation where it's destructive).
- Bounds: `MAX_PATCH_BYTES` (20,000 bytes) and `MAX_CHANGED_LINES` (200 lines) per call, checked before the patch is parsed/applied.
- Atomicity: the patched content is fully computed in memory before anything touches disk; the actual write goes through a temp-file-then-rename (`atomicWrite`), so a failed patch never partially writes and a successful one is atomic.
- `codingWorker` was given `applyPatch` alongside its existing read tools, with instructions describing an inspect → patch → confirm-the-diff sequence.

**Verified (by this session, since another session was still finishing this step when it started):**
- Confirmed via grep: no git tool, no shell/exec/spawn exposed to the worker (the only `child_process` usage anywhere is the supervisor's own `spawn('claude', argv)`, not a worker-facing tool).
- Found and fixed a real bug: the "empty patch" guard checked `parsePatch(patch).length === 0`, but the `diff` package's `parsePatch('')` returns a single file entry with zero hunks, not an empty array — so the guard was dead code and an empty patch string silently reported `success: true` without changing anything. Fixed to check `parsed.every((file) => file.hunks.length === 0)`, with a regression test.
- The write path had zero test coverage before this review despite being the most security-sensitive addition (writes, symlink protection for writes, atomicity, size bounds). Both this session and the other concurrently-running session independently wrote near-identical coverage for it (`repository-tools-write.test.ts`, 16 tests, kept as the canonical suite) — the duplicate written by this session was removed in favor of it; only the empty-patch regression (not covered by either) was kept as a small standalone file.
- 69 total tests passing at the end of this step's review (40 from Step 10 + `repository-tools-write.test.ts` + the empty-patch regression), `tsc --noEmit` clean, `workflow:demo` still works end-to-end against the real Ollama model.

**Concurrency note:** this step was implemented by one Claude Code session while another (this one) was independently reviewing it in the same working tree at the same time — confirmed via live file timestamps and a running process. No work was reverted; the review found and fixed one real bug and added the one gap in test coverage without duplicating the other session's work.

**Addendum (this session, after the above landed):** added the one Step-11 deliverable neither
concurrent pass had built yet — a live demo — and diagnosed why it's flaky.
- [`scripts/demo-write-worker.ts`](scripts/demo-write-worker.ts) / `npm run write-worker:demo` — builds a throwaway fixture repo (`internal/math.go` with an `Add` function, no test file), asks `codingWorker` to add unit tests for it, extracts every `applyPatch` tool call (including failed ones, and unwrapping the AI-SDK `{type:'json', value:...}` tool-output wrapper) from the response, prints "Files changed" / "Diff", then re-reads the fixture from disk (independent of what the model *claims*) to verify the file exists and production code is untouched.
- **Full autonomous runs are flaky, and it's diagnosed, not just observed:** four live runs of the full "figure it out yourself" flow against local `qwen3:8b` consistently stall after 3-4 read-tool calls (`listFiles`/`searchFiles`) with `finishReason: stop` and empty final text - it never reaches `readFile` or `applyPatch`. This lines up with a constraint already called out in `repository-tools.ts`'s own comments: this project's local Ollama models run with small context windows (often 4096 tokens), and by the 4th tool round-trip the accumulated tool output + reasoning tokens plausibly exhausts it, which Ollama/the SDK surfaces as a quiet "stop" rather than an error. This got worse, not better, after Step 12 grew the worker to 8 tools and a 10-step instruction block on top of Step 11's - more context spent on instructions and tool schemas alone.
- **`applyPatch` itself was proven to work live, isolated from that problem:** a direct probe prompt ("call applyPatch right now with exactly this patch, skip exploration") succeeded on the first try - `codingWorker` called `applyPatch`, got back `{success:true, path:"internal/note.txt", created:true, diff:"..."}`, and the file existed on disk with the right content afterward. This isolates the flakiness to the multi-step planning/context-budget problem, not to `applyPatch`'s implementation, wiring, or tool-result plumbing.
- Net: `applyPatch` is verified two independent ways - 16 deterministic unit tests (`repository-tools-write.test.ts`) covering correctness/security/atomicity, and one live, directed model call proving the real Ollama → tool-call → filesystem path works end to end. The realistic multi-step demo (`write-worker:demo`) is honest about failing to converge with this small local model under Step 12's larger instruction surface, and correctly reports that outcome rather than faking success.
- Not yet done: making the realistic (non-directed) demo converge reliably. Candidates for a follow-up, not attempted here since they reach outside Step 11's scope: a larger `OLLAMA_MODEL` / larger context (`num_ctx`) for this specific worker, or trimming what enters context per step (e.g. a leaner tool-result format).

## Step 12 — Controlled code execution (verify/repair loop)

**Goal:** let the worker verify its own patches — format and test them, and
make a bounded number of corrective attempts — without ever gaining
general-purpose shell access.

**Built:**
- `src/mastra/tools/execution-tools.ts` — four narrowly-scoped tools, all spawning a fixed binary with a model-built-nothing argv array (`spawn(cmd, args)`, never `shell: true`, so shell metacharacters in any input are inert):
  - `runGoTest({ package? })` — runs `go test <selector>` in the repository root. `package` defaults to `"./..."` and is validated against a whitelist regex (`^\.\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*(?:\.\.\.|[A-Za-z0-9_][A-Za-z0-9_.-]*)$`) that rejects `..`, absolute paths, and any shell metacharacter by construction (the charset simply doesn't include them).
  - `runGoFmt({ path })` — formats one file in place via `gofmt -l` (check) then `-w` (write only if needed), reusing `resolveWritablePathWithinRepository` from Step 11 for the same symlink/boundary protection writes already have. Invalid Go source is detected via `gofmt`'s own non-zero exit and reported cleanly without modifying the file (verified `gofmt` never writes on a parse error, both in real testing and in the automated suite).
  - `gitStatus({ path? })` / `gitDiff({ path? })` — read-only (`git status --short` / `git diff`), scoped to the repository root, with any optional path argument going through the same `resolveWithinRepository` boundary check as reads. No `git add`/`commit`/`push`/etc. exists anywhere in this codebase.
  - Shared `runControlledCommand` helper: hard timeout (`GO_TEST_TIMEOUT_MS` / `GO_FMT_TIMEOUT_MS` / `GIT_COMMAND_TIMEOUT_MS` env vars, sensible defaults, read fresh per call), bounded stdout/stderr capture with an explicit "`output truncated`" marker, and `detached: true` + process-group `SIGKILL` on timeout so a hung `go test` can't leave orphaned test binaries running.
- `codingWorker` gained all four tools directly (the worker itself decides when to format/test, same pattern as `applyPatch`), plus updated instructions describing the full loop: inspect → patch → format → test → (if failing) diagnose → corrective patch → format → test again, bounded to `MAX_REPAIR_ATTEMPTS` (env-configurable, default 3). `maxSteps` raised from 25 to 40 to give this longer loop room.
- `src/mastra/workflows/repair-loop-tracker.ts` — a safety net *and* the explicit state the durable-agent work will eventually need. It watches the worker's own tool telemetry via Mastra's `onIterationComplete` hook (not the worker's prose) for `runGoTest` results, and tracks `{ attempts, status, lastTestResult }` as a plain object scoped to one workflow run (no module-level or agent-level mutable state — a fresh tracker is created per run). On the attempt that reaches the configured limit, it injects feedback telling the model to stop and summarize, but still lets it produce a final answer; if the model ignores that and fails another test anyway, the *next* offending iteration is force-stopped (`continue: false`) regardless of what the model wants.
- `coding-task-workflow.ts`'s single step now returns `{ result, attempts, status, lastTestResult }` instead of just `{ result }` — explicit, serializable state on the step output rather than something only recoverable by re-parsing the model's final text.

**Deliberately not built:** any Claude-review step, git mutation (`add`/`commit`/`push`), PR creation, or GitHub/GitLab integration — all reserved for later steps per the brief.

**Tests added (all deterministic, no Ollama/Claude dependency):**
- `execution-tools-go-test.test.ts` (10 tests) — success, failure with real exit code/output, nonexistent package, default selector, a *real* hang-and-kill under a 1s timeout (asserts the run actually terminates in well under the test's would-be 30s sleep), repository-isolation fail-closed check, path-traversal/absolute-path rejection, five distinct shell-injection payloads (`;`, `&&`, backticks, `$()`, `|`) all rejected before ever reaching `spawn` (confirmed no injected `touch` marker file appears), and output truncation.
- `execution-tools-go-fmt.test.ts` (6 tests) — no-op on already-formatted file, real reformat-in-place, invalid-syntax handled cleanly without modifying the file, outside-path rejection, internal-symlink rejection, external-symlink rejection (with the real outside file confirmed untouched).
- `execution-tools-git.test.ts` (7 tests) — status/diff against a real git repo (clean tree, modified + untracked files, path-scoped diff), outside-path rejection, graceful non-crash on a non-git directory, and an explicit before/after check that `HEAD` and the index are byte-identical after a batch of status/diff calls (no mutation).
- `repair-loop-tracker.test.ts` (8 tests) — pure unit tests against the tracker with synthetic `onIterationComplete` contexts: both requested state transitions (`patch → format → test` success; `patch → format → test failure → repair → format → test success`), the soft-then-hard limit behavior, state carried correctly across a later success after being blocked, tool-error results ignored, and two trackers never sharing state.
- `coding-task-workflow-repair.test.ts` (3 tests) — same "stub only `codingWorker.generate`, run the real workflow" pattern as Step 10/11's workflow tests, but the stub actually drives the real `onIterationComplete` callback through a simulated tool-call sequence, proving the tracker is genuinely wired into the workflow step's output (not just unit-tested in isolation).

**Verified:** 91/91 tests passing, `tsc --noEmit` clean, no orphaned processes after the timeout test, `git status --short` shows only the expected new/modified files (no stray generated output).

## Steps 13–15 (not itemized here)

Not logged when they happened; reconstructed from artifacts still in the tree.
Step 15 in particular ran the full pipeline against the real `vus-metadata-v2`
repository with a wrapped-telemetry demo (`scripts/step15-real-repo-trial.ts`)
and added the objective `patchApplied`/`gofmtCompleted`/`goTestPassed`/`success`
fields to `codingTaskOutputSchema` (`coding-task-workflow.ts`) - visible today
but attributed to "Step 15.1" in code comments with no corresponding log entry.

## Step 16 — Autonomous real coding: pre-flight validation + Claude review

**Goal:** turn the existing supervisor → workflow → worker pipeline (Steps
9–15) into a fully autonomous, single real-task run against a human-chosen
repository, with (a) an explicit pre-flight repository check the model can
never influence, and (b) a genuinely read-only Claude review pass over the
worker's actual, on-disk result - the one piece the pipeline didn't have yet.

**Built:**
- `src/mastra/repository/validate-target-repository.ts` - standalone pre-flight check (exists, is a directory, has a `.git`, `git status` actually succeeds) run *before* any agent/workflow code sees the path. `TARGET_REPOSITORY` is read once, resolved, validated, and printed; nothing here lets either model choose or override it. `validate-target-repository.test.ts` (7 tests) covers unset/empty, nonexistent, file-not-directory, non-git-directory, and a real clean/dirty git fixture.
- `src/mastra/supervisor/claude-cli.ts` - extracted the `claude -p --tools '' --output-format json --json-schema ...` spawn logic out of `claude-supervisor.ts` into a shared `runClaudeCli` helper, so the new reviewer doesn't duplicate it. `claude-supervisor.ts` now calls this helper; behavior unchanged.
- `src/mastra/supervisor/claude-reviewer.ts` - `reviewCodingResult()`, a second tool-less `claude -p` call (`--tools ''`, same as the supervisor) that reviews a completed run: task, delegation, the worker's own final text (labeled non-authoritative), and the *actual* git diff/test/format results (labeled authoritative). Read-only by construction, not just by prompt - the CLI process it spawns has zero tool access. Returns a structured verdict (`satisfiesTask`, `followsConventions`, `correctnessConcerns`, `testsSufficient`, `modifiedUnrelatedFiles`, `workerVerifiedItsOwnWork`, `summary`, `verdict`).
- `scripts/step16-real-coding-task.ts` - the end-to-end driver: validates the repo, prints `git status --short` before, runs the supervisor, runs `codingTaskWorkflow` (telemetry mirrored the same way Step 15's trial script did), independently re-derives `git status`/`git diff --stat`/`git diff` afterward via direct `git` calls (untracked new files included via `git diff --no-index -- /dev/null <file>`, deliberately *not* `git add -N`, to stay index-clean), runs the Claude reviewer, prints an explicit "model claim vs. objective reality" comparison, and dumps the full iteration/tool-call trace. Never reverts, commits, or pushes.
- Fixed a latent `tsc --noEmit` failure in `repair-loop-tracker.test.ts` (pre-existing, unrelated to this step): four assertions read `.continue`/`.feedback` off an un-awaited `onIterationComplete(...)` call, whose declared return type (`IterationCompleteResult | Promise<...>`) includes a Promise arm; two `it` blocks weren't `async` yet accessed the result synchronously. Made those two callbacks `async` and awaited the call, matching the pattern already used by every other test in the same file.

**Live run against the real, human-selected repository** (`vus-metadata-v2` -
the user explicitly opted to keep using it for this run despite the general
guidance to pick something else): task was "add table-driven unit tests for
`SanitizeBodyForLog` in `pkg/utils/http.go`" (untested, real, bounded - not
`Add()`). Supervisor produced a precise delegation in ~49s. The worker read
`http.go`, `pkg/utils/` listing, and `string_test.go` (3 tool calls, 2 model
turns) and then stopped (`finishReason: "stop"`) without ever calling
`applyPatch`/`runGoFmt`/`runGoTest` - reproducing, on a fresh task, the exact
failure mode Step 11 diagnosed and left unresolved: `qwen3:8b`'s small
context window (this project's default `OLLAMA_MODEL`) gets exhausted a few
tool round-trips in and Ollama/the SDK surfaces it as a quiet stop rather
than an error. `patchApplied`/`gofmtCompleted`/`goTestPassed` were all
(correctly) `false`; the independent post-hoc `git status`/`git diff` check
confirmed the filesystem was untouched, matching the objective state exactly
(no discrepancy - the worker did not overclaim). The Claude reviewer
correctly rejected the run and, notably, caught that the worker's own prose
contained non-compiling Go (`"a".repeat(2001)`, a JS idiom; a wrong struct
field name; a wrong byte count) that was never written to disk - review by
diff/tool-state, not the model's narrative, is what caught this.

**Verified:** 102/102 tests passing (95 prior + 7 new), `tsc --noEmit` clean,
live run's on-disk state independently re-checked with `git status --short`
/ `ls` outside the harness after the run completed, matching the script's
own report exactly.

**Not built (per the brief):** any git mutation (`add`/`commit`/`push`),
arbitrary shell execution, worktree creation, or changes to the
Claude/Ollama split.

## Step 16 addendum — Trellis as context/task management (Claude and Ollama unchanged)

**Goal:** the user asked to wire in Trellis, but explicitly rejected using it
to replace the Ollama worker (that would just make the "worker" another
Claude agent, defeating the point of this project). Requested split: Claude
stays supervisor, Ollama stays worker, Trellis fills the *context/task
management* role - discovered to already be initialized inside the real
target repository (`vus-metadata-v2/.trellis/`, gitignored at the repo root,
Python-scripted, no separate `trellis` CLI installed on this machine).

**Built:**
- `src/mastra/trellis/trellis-integration.ts` - `hasTrellis()` (best-effort presence check), `readTrellisSpecContext()` (reads every `.trellis/spec/**/*.md` file directly via `fs`, no Python needed - Trellis's spec system is just Markdown), `createAndStartTrellisTask()`/`finishTrellisTask()` (best-effort `python3 .trellis/scripts/task.py create/start/finish`). Verified by reading `task.py`'s source that only `archive` has git-commit logic (`--no-commit` flag exists even there) - `create`/`start`/`finish` never touch git, and this integration never calls `archive`, so it can't trigger an unwanted commit. Everything is optional/best-effort: a target repository with no `.trellis/` (like `harness-engineering` itself) just skips this section without failing the run. 6 tests (`trellis-integration.test.ts`) cover both the present and absent cases against fixture repos.
- `scripts/step16-real-coding-task.ts` updated: detects Trellis, creates+starts a tracked task, reads all spec Markdown (~79KB in the real repo, trivial for Claude's context budget), and prepends it to the *supervisor's* prompt only - not the worker's. Claude digests up to ~10 guideline files and folds only what's task-relevant into the delegation's `requirements`; `codingWorker`'s own prompt/tools/context budget are completely unchanged from Step 15, which matters given the diagnosed small-context-window failure mode.
- `claude-reviewer.ts` gained an optional `trellisSpecExcerpt` input, included in the review prompt so "followsConventions" is judged against the repository's actual guidelines when they exist, not just general Go style.

**Verified:** 108/108 tests passing (102 prior + 6 new), `tsc --noEmit` clean.

## Step 16, second addendum — multi-ecosystem support + eshop as a second target repository

**Goal:** the user's next target repository, `eshop` (`/Users/anvh/go/src/github.com/anvh2/eshop`), is
JS/Node (Express + React + Postgres, Jest, ESLint/Prettier) - not Go. `runGoFmt`/`runGoTest` and
`codingWorker`'s Go-specific instructions don't apply there. Goal: generalize the pipeline to work
against either ecosystem without doubling the worker's tool/instruction surface (already a diagnosed
context-budget risk for the small local model), then set eshop up the same way vus-metadata-v2 was
- including its own Trellis spec, which didn't exist yet.

**Built:**
- `execution-tools.ts` gained `runPrettier`/`runJestTest` - JS/Node equivalents of `runGoFmt`/`runGoTest`, same `runControlledCommand`/boundary-check plumbing, spawned via `npx` (so they resolve whatever jest/prettier the *target* repo has installed, never this project's own). `runPrettier` explicitly warns the model to only run it on files it just created/rewrote, since - unlike gofmt - this repository's existing source isn't prettier-clean, so running it on a partially-edited file would produce a large, unrelated reformatting diff. 11 tests (`execution-tools-js.test.ts`), all fully hermetic: neither jest nor prettier is installed in this project and the network is unavailable here, so each fixture gets a stub `node_modules/.bin/{jest,prettier}` script instead of a real binary - proven to work via `npx`'s normal local-bin resolution, tests this module's command-construction/success-detection logic, not jest/prettier's real behavior.
- `coding-worker.ts` refactored from one static `Agent` export into `createCodingWorker(ecosystem: 'go'|'js')`, producing `codingWorkerGo`/`codingWorkerJs` - two separate agents, each with only its ecosystem's tools and instructions (never both merged into one worker, to avoid doubling the schema/instruction footprint). `codingWorker` kept as an alias for `codingWorkerGo` so every existing script/test that imported it is unaffected.
- `repair-loop-tracker.ts`'s `createRepairLoopTracker` gained an optional `toolNames: { format, test }` parameter (default: the Go names, so every existing caller/test is unaffected) - the format/test tool-name strings it watches for are now configurable instead of hardcoded to `runGoFmt`/`runGoTest`.
- `src/mastra/repository/detect-ecosystem.ts` - `detectEcosystem(root)`, presence-checks `go.mod` then `package.json`. `coding-task-workflow.ts`'s step now calls this (only when a repository is set; defaults to `'go'` otherwise, preserving the original demo's exact behavior) and picks `codingWorkerGo`/`codingWorkerJs` plus the matching tool-names accordingly - never asks a model to guess its own ecosystem. 3 tests.
- `index.ts` now registers `codingWorkerGo`/`codingWorkerJs` (per AGENTS.md's registration rule).
- `scripts/lib/run-real-coding-task.ts` - the Step 16 driver's orchestration extracted into a reusable `runRealCodingTask({ task, trellisTaskSlug, trellisTaskTitle })`, since a second target repository needed the identical ~300-line pipeline rather than a second copy. `scripts/step16-real-coding-task.ts` is now a thin historical wrapper (original Go/vus-metadata-v2 task, kept reproducible); `scripts/eshop-real-coding-task.ts` is the new JS/eshop wrapper (task: add unit tests for `buildFilterFromUrl` in `src/library/util/`, chosen after empirically verifying its actual behavior with a real `node -e` run - it has a real quirk where `sortBy`/`sortOrder`/`page`/`limit` can appear twice in the output, which the task description deliberately does not spoil, instead telling the worker to derive expected values from the source rather than assume).
- **eshop Trellis bootstrap** (it had no `.trellis/` at all): copied the ecosystem-generic scaffold (`.claude/agents,hooks,commands,skills/`, `.claude/settings.json`, `.trellis/scripts,agents/`, `.trellis/config.yaml`, `.trellis/workflow.md`, root `AGENTS.md`) from vus-metadata-v2 - verified byte-for-byte project-agnostic first (`grep` for vus-metadata/vus-tech/grpc/querybuilder across those files: zero hits). Then used the `trellis-spec-bootstrap` skill, scoped deliberately narrow (not a full-app sweep) to `src/library/` given that's this pipeline's likely working area, to write three real, evidence-backed spec files: `.trellis/spec/library/{index,testing-guidelines,code-style}.md` - every claim backed by a real file path (existing test files' `describe`/`it` shape, `.eslintrc.json`'s actual rule overrides, the two real `module.exports` patterns observed, the fact that Prettier isn't uniformly enforced on existing code - verified live via `npx prettier --check` against already-checked-in source). Added a `.trellis` line to `eshop/.gitignore` (it didn't have one, unlike vus-metadata-v2) so none of this - or future task/session state - is ever committed by accident. `.claude/` and `AGENTS.md` were deliberately left tracked/untracked-but-visible (not gitignored), matching vus-metadata-v2's own convention of treating those as shared, committable project config.
- `.env`: `TARGET_REPOSITORY` switched to eshop; `OLLAMA_MODEL` switched to `qwen3:8b-ctx8192` (the larger-context variant already available locally) - the concrete fix for the context-exhaustion stall observed on every live run so far, not yet tried.

**Verified:** 122/122 tests passing (108 prior + 11 JS-tool + 3 detect-ecosystem), `tsc --noEmit` clean. Not yet run live against eshop.

## Step 17 — local video transformation pipeline (new, unrelated feature)

**Goal:** the user asked for an entirely new capability with no relationship to
the coding-worker/supervisor pipeline above: a *local* video-to-video
transformation MVP - source video + character reference image (+ optional
outfit reference) in, a new video out where motion/pose/camera/background are
preserved but the person's appearance is steered toward the reference
character, via an AI backend abstracted behind a `VideoTransformationProvider`
interface so the concrete model can change later. Investigated this
repository first and confirmed there was zero prior art to reuse beyond
*patterns* (Mastra `createStep`/`createWorkflow`, the fixed-argv/no-shell
subprocess style in `execution-tools.ts`, colocated `node:test` files,
env-var-driven config) - no video/image/ComfyUI code existed anywhere.

**Built**, entirely under a new `src/mastra/video/` module plus one new
workflow, deliberately not touching `codingWorker`/`coding-task-workflow.ts`:

- `types.ts` - `VideoTransformationProvider` interface, `VideoTransformationInput`/`Result`/`Metadata`, `AppearanceVariation` ('none'|'subtle'), `VideoTransformError` with a closed set of error codes (missing/invalid inputs, ffmpeg unavailable, backend unavailable/timeout/failed, malformed backend response, output missing, insufficient disk space, invalid config) - every failure mode from the brief maps to a distinct, catchable code.
- `config.ts` - every backend/tooling knob (`VIDEO_AI_BACKEND`, `COMFYUI_BASE_URL`, `COMFYUI_WORKFLOW_PATH`, timeouts, `FFMPEG_BIN`/`FFPROBE_BIN`, fps/dimension caps, disk-space floor) read from `process.env` lazily, same pattern as `coding-worker.ts`'s `OLLAMA_BASE_URL` handling.
- `process-runner.ts` + `ffmpeg.ts` - fixed-argv subprocess execution (own copy of the `execution-tools.ts` spawn/timeout/process-group-kill pattern, kept local since that module's helper is private and tied to a repository-root request context that doesn't apply to arbitrary video/image paths); `probeVideo`/`extractFrames`/`assembleVideo`/`muxAudio`, with argv-construction kept as pure, separately-tested functions.
- `validate.ts` - file existence/extension checks, ffmpeg-availability check, best-effort `fs.statfs` disk-space check.
- `providers/mock-provider.ts` - in-process pass-through provider (no AI, no network) for tests and `VIDEO_AI_BACKEND=mock` dry runs.
- `providers/comfyui-provider.ts` + `providers/comfyui-workflow.sample.json` - HTTP adapter treating a locally-running ComfyUI instance purely as an inference service (submit workflow JSON with `{{TOKEN}}` placeholders -> poll `/history` -> download via `/view`); the sample graph chains ControlNet (pose, for motion preservation) + IP-Adapter (character reference) + AnimateDiff (temporal consistency) + VideoHelperSuite (frame load/combine), chosen after reasoning through current practical local/open-source options - no single bundled model does pose-preserving video-to-video + reference face + reference outfit end-to-end, so a swappable node graph made more sense than picking one model to hard-code.
- `pipeline.ts` - `prepareVideo` -> `runVideoTransformation` -> `assembleOutput`, each independently exported and dependency-injectable (`PipelineDeps`), composed into `runVideoTransformationPipeline` for the CLI. Cleans up the per-run working directory on success only; leaves it in place on failure for debugging.
- `workflows/video-transformation-workflow.ts` - a straight-line Mastra workflow (`validate-input` -> `prepare-video` -> `run-video-transformation` -> `assemble-output`, no branching/retries/parallelism) calling the same `pipeline.ts` functions; registered in `index.ts` alongside `codingTaskWorkflow`. Added `pipelineRuntime` (a mutable-property indirection around `defaultDeps`) purely so tests can substitute fakes for ffmpeg/the backend the same way `coding-task-workflow.test.ts` already monkeypatches `codingWorker.generate`.
- `scripts/video-transform.ts` - CLI (`npm run video:transform -- --video ... --character ... --outfit ... --output ...`), hand-rolled flag parsing (no new dependency).
- `VIDEO_TRANSFORMATION.md` - architecture, ComfyUI/ffmpeg setup, env vars, usage, and an explicit, non-hedged "Current limitations" section (no real ComfyUI run was possible in this session; outfit transfer is the weakest-supported part; Apple Silicon/unified-memory performance expectations). README.md and `.env.example` updated to point at it.

**No new npm dependencies** - ffmpeg/ComfyUI are external processes/services; Node 22's global `fetch` covers the ComfyUI HTTP client.

**Verified live, not just unit-tested:** ffmpeg was not installed on this
machine at the start of this step; installed via `brew install ffmpeg`
(user confirmed first) specifically to verify for real rather than trust
mocks alone. That surfaced one genuine bug: this ffmpeg build (9.0.2)
removed the global `-vsync` flag used in the frame-extraction command
(`Unrecognized option 'vsync'`) - fixed by dropping it (the `fps=` filter
already produces exactly one frame per tick; no replacement flag needed).
After the fix: `ffmpeg.itest.ts`'s 3 real-binary integration tests pass
(probe/extract/reassemble against a synthetic ffmpeg-generated video), and
a full manual CLI run (`VIDEO_AI_BACKEND=mock npm run video:transform`)
against a synthetic 320x240/15fps/3s source with a real audio track
produced a correct output MP4 - same resolution, fps, duration, and its
audio track intact, confirmed via `ffprobe` on the actual output file, not
just the tool's own report of success. CLI error paths (missing source
video, missing required flag) also manually confirmed to fail with clear
messages and a non-zero exit code. The ComfyUI HTTP adapter itself was
**not** verified against a real ComfyUI instance - no GPU/ComfyUI install
available in this session (see VIDEO_TRANSFORMATION.md's limitations
section) - only its request/response handling against a mocked `fetch`.

**Verified:** 169/169 unit tests passing (122 prior + 47 new: config,
validate, ffmpeg argv builders, mock/ComfyUI providers, pipeline
orchestration/error-handling, and the Mastra workflow with fakes swapped
in via `pipelineRuntime`), plus 3/3 real-ffmpeg integration tests
(`npm run test:integration`, excluded from the default `npm test` glob via
the `.itest.ts` suffix so ffmpeg's absence never breaks the main suite).
`tsc --noEmit` clean.

## 2026-09-27 — renderer-first Phase 0 benchmark

User changed implementation order to **0 → 2 → 3 → 4 → explicit video/architecture approval → 1 → 5 → 6**. Only Phase 0 executed; production jobs, PostgreSQL integration, workspace UI, recovery and hardening remain deferred. The revised sequence is in `ARCHITECTURE_REASSESSMENT.md` section M.

Standalone experiment: `benchmarks/phase0/`. Three original blouse photos produced a real **15.000s / 1080×1920 / 30fps / 450-frame** raw-photo control video in **36.49s** on confirmed **M2 / 16GiB**. Full decode/probe checks passed. Largest measured FFmpeg subprocess RSS: **759MiB**, not whole-machine peak. Output: `benchmarks/phase0/run-01/baseline-15s.mp4`. After the product-goal correction, this artifact is retained as a technical fallback/reference, not the intended creative target.

One real 384×512 / 16-frame AnimateDiff+IPAdapter trial was interrupted at ~60s after rapid system swap growth (~2.0GiB → ~4.8GiB); no usable AI clip. Conservative resource rejection, not confirmed OOM or completed inference timing. Its own prompt was confirmed stopped; no other work interrupted. Cloud candidates and LTX remain untested. Actual video quality awaits user review; Phase 2 has not started. Details, limitations, timings and artifacts: `benchmarks/phase0/RESULTS.md`.
