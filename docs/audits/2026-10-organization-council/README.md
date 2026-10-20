# Organization: agents and council meetings, verified on the real runtime (2026-10-20)

All three screenshots come from `apps/control-center/organization-council.test.mjs`, run in installed Chrome. The test allows reads only; every non-GET request is aborted. It ran against the actual built Mastra runtime with the Studio fork (`studio-fork/start.mjs`) on `127.0.0.1:4411`. Port 4111 belongs to another session's server and was not touched.

Data sources, all opened read-only:
- **Agents:** the server's own registration, which is the same objects Mastra holds. 25 are registered: 2 coding workers, 20 read-only specialists and 3 SCRIPTED council stand-ins. All are bound to `ollama/qwen3:8b`, because this preview has no `OLLAMA_MODEL` and no model config. No agent was refused or unavailable in this configuration; `council-adapter.test.ts` covers both states.
- **Council:** `CONTROL_CENTER_COUNCIL_WORKDIR=<integration worktree>/.workdir`, which holds two real council meetings:
  - `m12-ts-delegation-live-2`: LIVE, `ollama/qwen3:8b-ctx8192`, 7 calls, 2 `searchFiles`, trace `95cac200f1a7996601deb3c1b3b513d8`. Evidence is in `docs/audits/2026-10-m12-council/`.
  - `org-visibility-scripted-1`: SCRIPTED, held through the 4211 dev server for this check. Workflow run `fe9a36d9-d5ff-4dc7-b618-ff127dbc2fde`, trace `69021d0e8d703fc86228574c1a29f149`.
- **Scheduler:** the main checkout's `.workdir/scheduler/scheduler.db`. This is the existing M8.4/M9 data: 2 threads and 2 meetings in Discussions and Meetings.

The adapter was also run, read-only, over Session B's council store (`../agentic-engineering-council/.workdir`). All 5 meetings verified and were labelled correctly, including the LIVE run that failed closed (`srv-live-1`, outcome `failed`). The tool counts and trace ids match that session's published audit.

| File | Shows |
| --- | --- |
| `organization-agents.png` | Agents tab: registered agents, kinds, status, model binding, tools |
| `organization-council-live.png` | Council tab, LIVE meeting: model, calls, tool use, record path, integrity, workflow run, trace, outcome, agenda, participants, budgets |
| `organization-council-scripted.png` | Council tab, SCRIPTED meeting labelled as canned replies |

The existing browser tests passed on the same runtime and build: `studio.test.mjs` 1/1 (Organization, Discussions, Meetings, Studio navigation) and `npm run test:ui` 3/3.
