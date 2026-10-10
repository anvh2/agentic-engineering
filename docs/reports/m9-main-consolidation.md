# M9 main consolidation and :4111 cutover

Verdicts: **MAIN_WORKSPACE_CLEAN** and **MASTRA_4111_CUTOVER_READY**.

The canonical checkout `/Users/anvh/go/src/github.com/anvh2/agentic-engineering` is on `main`. `:4111` now serves the integrated, pinned Studio, with the Organization embed and the read-only Gateway, against the authoritative scheduler database. Nothing was pushed. Date: 2026-10-10.

"Clean" means every dirty file is accounted for. Four unrelated paths remain, deliberately and unchanged, pending their owners (section 5).

## 1. Git

| Item | Value |
|---|---|
| Canonical checkout | `main`, HEAD at the commit that adds this report. Its parent is the smoke-test fix, and before that `8177c03`. |
| `main` history | `e777a10` (initial) → `47d4c06` (fast-forward from `integration/m9-org-collaboration`) → `8177c03` (fast-forward, cleanup report) → this session's commits |
| Contains | Engineering Core and M9.0 (`50e0335`), the recovery line through `33228d4`, Collaboration Core (`65a6252`), the Studio fork, Gateway and Organization UI (`9ce52ea`, `d10393f`, merge `0742a67`), and the collaboration UI (`ab7fe94`, `47d4c06`) |
| Removed | the worktree `/Users/anvh/go/src/github.com/anvh2/agentic-engineering-main`. It was clean, with no untracked or ignored files, no open files and no processes. It was removed with plain `git worktree remove`; the `main` branch is unaffected. |
| Remaining worktrees | `/private/tmp/agentic-m84-control-center`, `/private/tmp/agentic-m9-collaboration` and `/private/tmp/agentic-m9-org-collab`. All are clean, and all their commits are on `main`. Removal plan: `docs/reports/main-workspace-cleanup.md`. |

**The switch itself:**
- `git switch main` (no `--force`), then `git merge --ff-only 8177c03`.
- The modified `.gitignore` carried over unchanged; it is identical on both branches.
- No untracked path collides with `main`.

## 2. Pre-restart safety (verified immediately before the stop)

- **Process tree:** the old `:4111` was `npm run dev` (15419, detached) → `mastra dev` (15439, a watching bundler) → runtime 41902, plus `caffeinate -dimsu` (15421) and esbuild (15453).
- **No dependent session:** it had been launched from Claude session `5ed9bc98…` (pid 10746), which no longer exists, and it had no worker children.
- **No active work:**
  - every Mastra `codingTaskWorkflow` run is terminal (13 success, 2 canceled);
  - the scheduler has no claimed, coding or verifying task, no lease owner and no locks (last event Oct 6);
  - the model-permit store has no leases or waiters;
  - no lead CLI, scheduler or worker process exists.

## 3. Restart actions

1. **Stop.** At 18:41:19, `kill -TERM 15419` (the npm parent). npm, `mastra dev`, the runtime, caffeinate and esbuild all exited within 2 s, and `:4111` was confirmed free.
2. **Backup.** Mastra storage (`mastra.db*`, `mastra.duckdb*`) and a copy of the scheduler DB went to `.workdir/cutover-backup-20261010-184127/`, which is gitignored.
3. **Switch** and fast-forward as in section 1.
4. **Build:**
   - `npm ci --prefix apps/control-center && npm run build --prefix apps/control-center`;
   - `.workdir/studio-dist` was copied from the verified pinned build after checking that its manifest matches this checkout's `studio-fork/upstream.json`, `organization.patch` and `upstream-build-fix.patch`. `node studio-fork/build.mjs` reproduces it.
   - `MASTRA_TELEMETRY_DISABLED=1 npm run build -- --studio` produced a bundle with Studio enabled. No `.env` was copied into it and no credential was inlined.
5. **Start:** detached, parent launchd, runtime pid 74904 under caffeinate 74907. The log is `.workdir/mastra-4111.log`.

```sh
R=/Users/anvh/go/src/github.com/anvh2/agentic-engineering
cd "$R/src/integrations/mastra/public"   # keeps the existing mastra.db / mastra.duckdb
( env -i PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" TMPDIR="$TMPDIR" LANG="${LANG:-en_US.UTF-8}" \
  NODE_ENV=production PORT=4111 MASTRA_HOST=127.0.0.1 MASTRA_TELEMETRY_DISABLED=1 \
  AGENTIC_SCHED_DB="$R/.workdir/scheduler/scheduler.db" \
  CONTROL_CENTER_ENABLED=1 CONTROL_CENTER_ASSETS_DIR="$R/apps/control-center/dist" CONTROL_CENTER_STUDIO_ORIGIN=http://localhost:4111 \
  MASTRA_STUDIO_PATH="$R/.workdir/studio-dist" \
  nohup caffeinate -dimsu /opt/homebrew/bin/node --env-file="$R/.env" "$R/.mastra/output/index.mjs" > "$R/.workdir/mastra-4111.log" 2>&1 & )
```

**About this launch:**
- `--env-file` supplies the same configured variables the old runtime had (`GEMINI_API_KEY`, `MASTRA_PLATFORM_*`, `OLLAMA_*`, `TARGET_REPOSITORY`) without copying them anywhere.
- `env -i` keeps Claude session tokens out of the long-lived server. The old runtime had also inherited `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` from that session. If a provider's TLS needs them, add them explicitly.
- The server now binds `127.0.0.1` only (previously `*`), and it is a production build rather than `mastra dev`. Source changes need a rebuild and a restart; there is no hot reload.
- No scheduler is started; the Gateway only reads the scheduler DB.
- **To stop:** `kill -TERM 74904`. caffeinate exits with it.

## 4. Verification at :4111

| Check | Result |
|---|---|
| Routes | `/`, `/organization` (direct load), `/agents`, `/workflows`, `/traces`, `/organization-app/`, `/control-center/v1/{snapshot,collaboration}` and `/api/workflows` return 200. An unknown Gateway path returns 404, POST returns 405, and a cross-origin request returns 403. |
| Authoritative data | Snapshot `source: connected`, objective `M5-ESHOP-2A`, four agents with activity UNKNOWN (none invented). Collaboration is `AVAILABLE` with 0 threads and the reason "No collaboration events are persisted in this scheduler database." The demo thread `t-design` returns 404, so this is not the demo DB and no fake meeting is shown. |
| Scheduler SSE | `retry: 2000`, snapshot, and checkpoint `f77b6078…:25`. Reconnecting with `Last-Event-ID` gives no replayed or duplicate events; a bogus cursor gets `reset`. |
| Collaboration SSE | checkpoint `id: 0`; `Last-Event-ID: 0` resumes; a cursor beyond the head gets `reset`. Browser-level drop and reconnect was proven on `:4411` with this identical build (`Last-Event-ID: 23`, recovered without a reload). Repeating it here would need another `:4111` restart. |
| Real-Studio smoke | `STUDIO_TEST_ORIGIN=http://127.0.0.1:4111 CHROME_EXECUTABLE=… node --test apps/control-center/studio.test.mjs` passes 1/1. `requiredPortVerified: true`; 122 requests, all GET, all to port 4111, none to 4310; 0 page errors. Covered: the Organization sidebar, reload, Agent Chart, Verifier role, Discussions and Meetings (empty state), Usage, and Agents, Workflows and Traces. |
| Tests in the canonical checkout | Both typechecks clean; Gateway 21/21, UI unit 6/6, collaboration 33/33. The full suite on the consolidated tree (`47d4c06`, in the identical integration worktree) was 963/964. The one failure is the known Gemini HTTP smoke timing case, which passes 22/22 when rerun alone. |

**Smoke-test fix, committed with this report:** `studio.test.mjs` had no branch for an authoritative store that is *available but empty*. It now asserts "No reported threads." and "No reported meetings.", the reason text, and zero messages.

**Evidence artifact:** in `studio-organization.png` from the smoke run, Agents fades over Organization. The test opens `/`, which redirects to `/agents`, and the screenshot was taken mid-transition. A settled direct load of `/organization` renders cleanly.

Evidence lives in `.workdir/control-center/studio-screenshots/`, which is gitignored.

## 5. Unrelated files, preserved unchanged

| Path | Status |
|---|---|
| `.gitignore` | Still modified, with the same single change (`docs/audits/**/pre-restructure-backup.tgz` → `docs/audits/*`). Owner's review needed; not committed. |
| `docs/architecture/components.md` | Untracked and unchanged (554 B, Oct 9). Owner's decision. |
| `tests/evaluation/` | Untracked and unchanged (8 files, Oct 7). Owner's decision. |
| `.turbo/` | Untracked generated cache (33 MB). Never commit it. |

## 6. Rollback

```sh
R=/Users/anvh/go/src/github.com/anvh2/agentic-engineering
kill -TERM 74904                               # the new runtime; confirm :4111 is free
git -C "$R" switch recovery/2026-10-03         # local edits carry back; no --force
# only if Mastra storage was damaged:
#   cp -p "$R/.workdir/cutover-backup-20261010-184127/"mastra.* "$R/src/integrations/mastra/public/"
cd "$R" && nohup caffeinate -dimsu npm run dev > "$R/.workdir/mastra-dev.log" 2>&1 &   # the original launch
```

`main` keeps all the integrated commits either way; a rollback changes only what the checkout and `:4111` serve.

## 7. Still running and other notes

- `:4411` is this session's integration preview, serving the deterministic fake-agent demo DB, which is labelled as such. It lives in `/private/tmp/agentic-m9-org-collab` and can be stopped when no longer needed.
- `tail -f ~/.ollama/logs/server.log` (pid 30836) belongs to another session and was not affected. No other process was touched.
- **Remaining foundation work:** a model-backed participant for Core B's coordinator, so that real, non-fake meetings can be recorded (not run here: no paid providers); pagination for the collaboration snapshot; trace links once real adapters report trace ids; retiring the `/private/tmp` worktrees per the cleanup report.
