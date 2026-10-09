# Local Engineering Control Center

A local, read-only Gateway and React UI for the existing scheduler. The Organization page is the main slice: compact agent table and keyboard-accessible inspector, task and run evidence, scoped token fields, provider summary and scheduler timeline. Overview/Objectives/Runs/Reviews are small views of that same snapshot. Token telemetry and live inference remain UNKNOWN until Core exposes the required read models.

## Start

Requires the repository's Node >=22.13 (the validated runtime is Node 22.23.2). The shell default on this machine is Node 20; use the Homebrew Node path below. No Mastra server is started or changed by these commands.

From the implementation worktree:

```sh
cd /private/tmp/agentic-m84-control-center
export PATH="/opt/homebrew/bin:$PATH"
npm ci --prefix apps/control-center
npm run build --prefix apps/control-center
AGENTIC_SCHED_DB=/Users/anvh/go/src/github.com/anvh2/agentic-engineering/.workdir/scheduler/scheduler.db npm run start --prefix apps/control-center
```

Open `http://127.0.0.1:4310`. Select a persisted scheduler batch in the Objective selector. Missing/unreadable databases produce the disconnected screen. No fixtures are served by the CLI; screenshots/tests use an explicitly synthetic test database.

The worktree currently reuses the original checkout's installed root dependencies via an ignored `node_modules` symlink. After integrating into a fresh checkout, run `npm ci` at the root as well. UI dependencies have their own lockfile; root dependency manifests are unchanged.

Optional environment variables (pass only non-secret configuration; do not load `.env`):

| Variable | Default / purpose |
| --- | --- |
| `CONTROL_CENTER_PORT` | `4310`, loopback only |
| `AGENTIC_SCHED_DB` | Existing scheduler DB; otherwise uses the existing `resolveSchedulerDbPath()` logic |
| `AGENTIC_SCHED_ROOT` | Existing Core scheduler root override |
| `CONTROL_CENTER_CAPACITY_DB` | Unset; optionally point to the existing machine-wide capacity DB for aggregate permit counts |
| `CONTROL_CENTER_STUDIO_ORIGIN` | `http://localhost:4111`; used only for links to existing Mastra run pages |

Stop with Ctrl-C. No Submit/Approve/Cancel or other write operations exist. Opening a trace follows a link in another tab; the Gateway makes no Mastra requests. No cloud quota is used by this app.

## Verification

```sh
export PATH="/opt/homebrew/bin:$PATH"
npm run typecheck
npm run typecheck --prefix apps/control-center
npm run test --prefix apps/control-center
npm run build --prefix apps/control-center
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:ui --prefix apps/control-center
env -u AGENTIC_REAL_PROVIDER_SMOKE npm test
```

Browser checks use installed Chrome/Chromium (no bundled browser download), synthetic SQLite data and an ephemeral loopback server. They cover keyboard inspector focus/escape, themes, selected-objective data, live state/review/run changes, disconnect, and 1440/768/390px layouts. Screenshots go into ignored `.workdir/control-center/screenshots/`. No real provider calls are allowed in validation. Some repository tests require local sockets and sandbox subprocess access.

Implementation uses React/TypeScript, Lucide, native accessible controls, a small CSS token sheet and esbuild. No Next.js, new server framework, UI framework, React Flow, Tailwind pipeline or Radix package was necessary for this first table/inspector slice. Sidebar and theme tokens follow the requested neutral Studio-style direction. Native buttons/select/details give keyboard behavior without adding a component dependency tree.

See [the integration contract and Core handoff](../architecture/control-center-contract.md) for known data gaps, SSE behavior, activity semantics and the proposed versioned schemas.

## Delivery validation — 2026-10-10

Verdict: **CONTROL_CENTER_SLICE_READY** for this first read-only slice, with the explicit Core telemetry gaps described above.

- Root `npm run typecheck`: passed.
- UI `npm run typecheck --prefix apps/control-center`: passed.
- Production UI build: passed.
- Gateway adapter/contract/usage/HTTP/SSE tests: **13 passed**.
- Installed-Chrome end-to-end browser check: **1 passed**, including keyboard interaction, dark/light themes, desktop/narrow layouts, review/run changes and disconnection. Screenshots were inspected.
- Full repository suite with real-provider opt-in removed: **755 passed, 1 failed** (756 tests). The failure was in the unchanged `tests/provider-smoke/codex-scheduler-smoke.test.ts`, “a second signal exits promptly…”: the test expected an owned PID of `0`, while the cancellation report contained a real PID. An isolated rerun of that unchanged file passed **6/6**; this appears timing-sensitive. The full-suite failure is not concealed and no provider/Core test was changed to address it.
- No real model/provider calls, cloud usage, scheduler execution outside synthetic tests, existing Mastra process changes, or pushes.

Branch: `codex/m8.4-control-center`, based on `ff5f234`. Only the new Platform directories and these handoff documents are committed. To integrate, cherry-pick the delivery commit reported by Codex onto the intended integration branch; root dependency manifests and Core ownership files are unchanged. Install the UI subpackage from its lockfile and follow the launch commands above.

A sanitized, explicitly synthetic [snapshot example](../architecture/examples/control-center-synthetic.json) illustrates the wire shape; it is never loaded by production code. The outer `_notice` is documentation metadata, not an API field.
