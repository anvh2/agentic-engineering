# Main workspace cleanup

Verdict: **MAIN_WORKSPACE_CLEANUP_BLOCKED**.

`main` is consolidated and verified. However, the canonical checkout (`/Users/anvh/go/src/github.com/anvh2/agentic-engineering`) cannot be switched to it safely yet, for two reasons outside this session's ownership (section 3). Nothing was deleted, reset, stashed, cleaned or pushed, and no worktree was removed. Neither `:4111` nor `:4411` was stopped or restarted. Date: 2026-10-10.

## 1. Branches and HEADs

| Branch | HEAD | Checked out at | Reachable from `main` |
|---|---|---|---|
| `main` | `47d4c06` | `/Users/anvh/go/src/github.com/anvh2/agentic-engineering-main` (owner unknown, see section 3) | — |
| `recovery/2026-10-03` | `33228d4` | the canonical checkout | yes |
| `integration/m9-org-collaboration` | this report's commit (one docs commit on top of `47d4c06`) | `/private/tmp/agentic-m9-org-collab` | `47d4c06` yes; this report not yet |
| `codex/m8.4-control-center` | `d10393f` | `/private/tmp/agentic-m84-control-center` | yes |
| `feature/m9-engineering-collaboration` | `65a6252` | `/private/tmp/agentic-m9-collaboration` | yes |

**`main` was fast-forwarded** by this session from `e777a10` (the initial Mastra commit) to `47d4c06`. The command was `git fetch . integration/m9-org-collaboration:main`, which refuses anything that isn't a fast-forward; the reflog reads `fetch …: fast-forward`. No remote is configured, and nothing was pushed.

**`main` contains:**
- Engineering Core and M9.0 (`50e0335`), and the recovery line through `33228d4`;
- Collaboration Core (`65a6252`);
- the Studio fork, Gateway and Organization UI (`9ce52ea` and `d10393f`, merged in `0742a67`);
- the collaboration UI connection (`ab7fe94`) and its report (`47d4c06`).

`apps/control-center/`, `studio-fork/`, `src/runtime/collaboration/` and `src/integrations/control-center/` are all present at `47d4c06`.

**Exact-tree verification at `47d4c06`:**
- **Bounded runs:** both typechecks are clean and the UI build is ok. Collaboration tests pass 33/33, Gateway 21/21, UI unit 6/6, the standalone browser tests 3/3, and the real-Studio smoke on `:4411` 1/1.
- **Full `npm test`:** 964 tests, 963 pass, 1 fail, in 893 s. The failure is the known intermittent Gemini HTTP smoke › *active-execution timeout*: it timed out after 30 s waiting for the fake Gemini CLI to start under load. That file passes 22/22 when rerun alone, and the consolidation changed no Gemini, smoke or executor file. It is not a regression.

## 2. Outstanding files in the canonical checkout

All four were left untouched. None was committed, staged or discarded, because this session does not own any of them.

| Path | What it is | Owner | Class | Blocker for switching? |
|---|---|---|---|---|
| `.gitignore` (modified) | Widens `docs/audits/**/pre-restructure-backup.tgz` to `docs/audits/*`. That would silently ignore every *new* audit file; the 101 tracked ones stay tracked. | Earlier session (recorded as unrelated work in the M9.0 report) | 4: unknown intent, a policy change that needs its owner's review | No: `.gitignore` is identical in `recovery` and `main`, so the edit carries over |
| `docs/architecture/components.md` (untracked, Oct 9) | A 554-byte mermaid component diagram | Earlier session (listed in the M9.0 report) | 1: possibly valuable docs, but unclaimed | No: absent from `main` |
| `tests/evaluation/` (untracked, Oct 7, 8 files) | An evaluation harness. It calls `git` only, with no model or network. The M9.0 report records its 9 tests passing inside that suite run. | Earlier session (the M9.0 report says "belongs to other work") | 1: possibly valuable tests, but unclaimed. Not run here, because its work root can sit inside the checkout. | No: absent from `main` |
| `.turbo/` (untracked, 33 MB, written 15:28–16:01 Oct 10) | A turbo build cache. Nothing in the root `package.json` uses turbo. | Unknown (a build tool) | 3: generated cache, must never be committed | No |

**To integrate the docs or tests:** the owning session confirms they are complete. Then commit only those paths on a preservation branch, for example `git switch -c preserve/evaluation-harness` followed by `git add tests/evaluation docs/architecture/components.md`, run `node --test tests/evaluation/*.test.ts`, and fast-forward `main`. `.turbo/` should be added to `.gitignore` by whoever owns the `.gitignore` edit.

## 3. Why the canonical checkout was not switched to `main`

1. **`main` is already checked out in another worktree,** `/Users/anvh/go/src/github.com/anvh2/agentic-engineering-main`. It was created at 18:23:27 today, not by this session, and its owner is unknown. It is clean and unbuilt, and nothing is running in it. Git refuses to check out `main` in a second worktree. Bypassing that (`--ignore-other-worktrees`) would leave two working trees on one branch, which is not safe.
2. **The canonical checkout is live-served.** `:4111` is a detached `npm run dev` (pid 15419) → `mastra dev` (15439) → runtime (41902), with the canonical checkout as working directory.
   - `mastra dev` runs a watching bundler that restarts the server on change. On restart it also POSTs `/__restart-active-workflow-runs`.
   - `main` changes `src/integrations/mastra/index.ts`, the dev server's entry file.
   - Switching branches here would therefore restart `:4111` and its active workflow runs, which this brief forbids.

The dirty files are **not** a blocker. Their paths don't collide with `main`, and `.gitignore` is unchanged between the branches, so `git switch main` would carry them over without loss.

**Safe switch procedure** (no `--force`, nothing discarded), once the operator approves:

```sh
# 1. The owner of the extra worktree releases main. It is clean, so plain remove works; do not force.
git -C /Users/anvh/go/src/github.com/anvh2/agentic-engineering worktree remove /Users/anvh/go/src/github.com/anvh2/agentic-engineering-main
# 2. Stop the :4111 dev server through its owning session (pid 15419 is the npm parent), or accept its restart.
# 3. Switch. Local edits carry over; git aborts on its own if anything would be overwritten.
cd /Users/anvh/go/src/github.com/anvh2/agentic-engineering && git switch main
git status --short   # expect the same 4 paths as section 2
# 4. Bring in this report and anything later on the integration branch (fast-forward only).
git merge --ff-only integration/m9-org-collaboration
```

Relaunching `:4111` from `main` (with the Organization embed) is the separate, already-documented cutover in `docs/operations/m8.4-studio-organization.md`:

- build: `npm ci --prefix apps/control-center && npm run build --prefix apps/control-center && node studio-fork/build.mjs && MASTRA_TELEMETRY_DISABLED=1 npm run build -- --studio`;
- launch with working directory `src/integrations/mastra/public`, so the existing `mastra.db` and `mastra.duckdb` stay in use;
- start the runtime only after the old one has stopped, because DuckDB holds a single-writer lock;
- pass `--env-file=<checkout>/.env` to keep its configured variables (`GEMINI_API_KEY`, `MASTRA_PLATFORM_*`, `OLLAMA_*`, `TARGET_REPOSITORY`);
- set `CONTROL_CENTER_ENABLED=1` and `MASTRA_STUDIO_PATH=<checkout>/.workdir/studio-dist`.

## 4. Worktrees

All four extra worktrees are clean, and every commit in them is reachable from `main`. No branch work is lost by removing any of them.

| Worktree | Running now | Unique artifacts (all gitignored) | Removable? |
|---|---|---|---|
| `/private/tmp/agentic-m9-collaboration` | nothing | none | **Yes**, after confirmation |
| `/private/tmp/agentic-m84-control-center` | nothing | 2.7 GB of regenerable Studio build inputs (`studio-source`, `studio-pnpm-store`, `studio-npm-cache`), `studio-dist` (an identical copy is in the integration worktree), `.mastra` (307 MB), and **M8.4 browser evidence** in `.workdir/control-center/` | **Yes**, after the evidence is copied |
| `/private/tmp/agentic-m9-org-collab` | **this session's `:4411` preview** (pids 86357 and 86363) | `studio-dist` (the verified pinned build), `m9-collab-demo/scheduler.db` (recreatable with the seed script), **M9 browser evidence**, `.mastra` | **Not yet**: it serves `:4411`, and its branch holds this report until `main` fast-forwards |
| `/Users/anvh/go/src/github.com/anvh2/agentic-engineering-main` | nothing | none (no build, no `node_modules`) | Owner's call. It blocks the switch in section 3. |

The three `/private/tmp` worktrees use a `node_modules` symlink to the canonical checkout's `node_modules`. Removing a worktree deletes only the link. Do not delete or reinstall the canonical `node_modules` while they are in use. Note also that `/private/tmp` does not survive a reboot.

**Cleanup commands, to run only after explicit operator confirmation.** None of them forces anything.

```sh
R=/Users/anvh/go/src/github.com/anvh2/agentic-engineering
mkdir -p "$R/.workdir/evidence"                      # gitignored, persistent
cp -R /private/tmp/agentic-m84-control-center/.workdir/control-center "$R/.workdir/evidence/m8.4-control-center"
cp -R /private/tmp/agentic-m9-org-collab/.workdir/control-center      "$R/.workdir/evidence/m9-org-collab"
git -C "$R" worktree remove /private/tmp/agentic-m9-collaboration
git -C "$R" worktree remove /private/tmp/agentic-m84-control-center
# after :4411 is retired and main includes this report:
git -C "$R" worktree remove /private/tmp/agentic-m9-org-collab
# merged branches (-d refuses anything not merged):
git -C "$R" branch -d feature/m9-engineering-collaboration codex/m8.4-control-center integration/m9-org-collaboration
```

`git worktree remove` refuses a dirty worktree. If it refuses, stop and inspect; do not add `--force` without a reason.

## 5. Runtime processes on old directories

| Port or process | Directory | Owner | Data |
|---|---|---|---|
| `:4111` `npm run dev` 15419 → `mastra dev` 15439 → runtime 41902 | canonical checkout (`recovery/2026-10-03`), runtime working directory `src/integrations/mastra/public` | Another session/operator (detached, up about 1 d 21 h) | Scheduler `<checkout>/.workdir/scheduler/scheduler.db`; Mastra `src/integrations/mastra/public/mastra.db` and `mastra.duckdb` |
| `:4411` `start.mjs` 86357 → runtime 86363 | `/private/tmp/agentic-m9-org-collab` | This session | Demo scheduler DB `.workdir/m9-collab-demo/scheduler.db`, a read-only copy plus the fake-agent meeting; isolated preview Mastra storage |
| `tail -f ~/.ollama/logs/server.log` (30836) | canonical checkout | Another session | — |

## 6. Remaining blockers

1. **The extra `main` worktree.** Its owner must release it before the canonical checkout can switch.
2. **The live `:4111` dev server** in the canonical checkout. Switching restarts it; the operator must stop it or approve the restart.
3. **The outstanding files** (section 2) need their owners' decision. They don't block the switch.
4. **This report** sits on `integration/m9-org-collaboration` until `main` can fast-forward (procedure step 4).
5. **Carried over:** `:4111` Organization acceptance is still pending, and no real, non-fake meeting has been recorded yet.
