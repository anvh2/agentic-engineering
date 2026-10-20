# Engineering council demo (M11.x, issue #54)

Three read-only Mastra specialists hold one bounded design meeting on the existing M9/M10 meeting engine and leave a durable, inspectable record. Nothing they say is adopted: the result is a **proposed** decision that a human accepts or rejects.

| Round | What happens | Stored as (existing engine) |
| --- | --- | --- |
| 1 | Each specialist proposes **independently**. The proposal prompt is built from the question alone, so nobody sees another proposal. | `proposal` |
| 2 | Each specialist critiques exactly one *other* member's proposal: object or support, with evidence. | `objection` / `support` |
| 3 | The chair (Architect) synthesizes a proposed decision, lists disagreements and uncertainties. | `decision` (`authority: none`) |

Two modes, kept apart everywhere (record header, provider identity, CLI banner):

- **SCRIPTED**: offline, deterministic, free. Real Mastra agents, real read-only tools, real store and coordinator; only the language model is a script. Proves wiring and rules, **not** model quality. Provider is recorded as `scripted/scripted-council-1`.
- **LIVE**: the local Ollama model, opt-in. Never a paid or remote provider.

## Demo commands

Run from the repository root. Node >= 22.13, `npm ci` done.

```shell
# 1. Readiness: pack, Mastra registration, the 3-seat panel, both modes, with fail-closed reasons. No model call.
npm run council -- status

# 2. Start Mastra (Studio + API). The startup log prints a [council] readiness line.
#    Add the LIVE variables only if you will run step 4.
AGENTIC_COUNCIL_LIVE=1 OLLAMA_MODEL=qwen3:8b-ctx8192 OLLAMA_NUM_CTX=8192 npm run dev
#    If port 4111 is taken by another server, use another one: PORT=4211 npm run dev  (then pass --server below)

# 3. SCRIPTED council through the server, so the run is traced in Studio (about 1 second).
npm run council -- run --meeting-id demo-scripted

# 4. LIVE council on the local model (about 9 minutes on an Apple-silicon Mac with qwen3:8b).
AGENTIC_COUNCIL_LIVE=1 OLLAMA_MODEL=qwen3:8b-ctx8192 OLLAMA_NUM_CTX=8192 npm run council -- status --probe   # must say LIVE ... READY
npm run council -- run --live --meeting-id demo-live

# 5. Inspect.
npm run council -- show demo-live            # council record (Markdown); --json for the structured record
open http://localhost:4111                   # Studio: Workflows > engineering-council-workflow, and Observability (trace)
```

Without a server, `npm run council -- run --in-process` runs the same workflow in the CLI process (no Studio trace).
`--question "..."` replaces the built-in example question. Re-running an **open** meeting id resumes it; a **closed** one returns its record without any model call.

Exit codes: `0` decided, `1` closed without a decision (`unresolved`, `failed`, `budget_exhausted`), `2` refused (nothing ran, no model call), `3` server unreachable, `130` suspended (resumable).

## Expected output

SCRIPTED (observed 2026-10-19, server run):

```
Council srv-scripted-2 [SCRIPTED] -> decided (decision m7 by council-architect: accept m1)
Panel: architect (chair), security-reviewer, reliability-reviewer on scripted/scripted-council-1
Rounds: 1 proposal -> 2 critique -> 3 synthesis; proposals 3, critiques 3 (2 objection, 1 support)
Disagreement: raised, 2 objection(s) outstanding
Proposed decision: Keep the single manifest-bounded re-ask for read-only specialists in the Mastra workflow, ...
Human approval: PENDING (nothing was adopted)
Accounting: 7 model call(s), 0 re-ask(s), 0 invalid, tokens in 370 / out 170; turns 7/9
SCRIPTED: canned replies. This proves wiring and rules, not model quality.
```

LIVE (observed 2026-10-19, `ollama/qwen3:8b-ctx8192`, commit e9806d4, 16:07:40Z to 16:16:29Z):

```
Council srv-live-2 [LIVE] -> decided (decision m7 by council-architect: defer m1)
Panel: architect (chair), security-reviewer, reliability-reviewer on ollama/qwen3:8b-ctx8192
Rounds: 1 proposal -> 2 critique -> 3 synthesis; proposals 3, critiques 3 (3 objection, 0 support)
Disagreement: raised, 3 objection(s) outstanding
Proposed decision: Propose allowing a single retry on malformed replies while deferring to the scheduler, but require manifest escalation policy validation.
Human approval: PENDING (nothing was adopted)
Accounting: 7 model call(s), 0 re-ask(s), 0 invalid, tokens in 14137 / out 7021; turns 7/9
```

The full records, including a LIVE run that **failed closed**, are in [docs/audits/2026-10-m11x-engineering-council/](../audits/2026-10-m11x-engineering-council/README.md). Model output varies between live runs; the shape (3 proposals, critiques, one synthesis or an explicit failure) does not.

## What is where

| Artifact | Location |
| --- | --- |
| Meeting events (hash-chained, the source of truth) | `.workdir/council/council.db` (the collaboration store's own tables; not the scheduler database) |
| Per meeting | `.workdir/council/<id>/`: `meeting.json` (roster, limits), `calls.jsonl` (every model call incl. re-asks and lost calls), `record.json` + `record.md` (council record), `meeting-record.json` + `meeting-record.md` (the M9/M10 engine's own record and renderer), `workflow-runs.jsonl` |
| Traces | Studio Observability: one trace per workflow run; `workflow_run > workflow_step x3 > agent_run x7 > tool_call / model_generation`, each agent span tagged `council`, `<specialist>`, `<phase>` with metadata `councilMeetingId`, `round`, `attempt`, `workflowRunId` |
| Status as JSON | `GET /council/v1/status[?probe=1]` on the Mastra server |

## How it is built (reuse first)

Reused unchanged: `MeetingCoordinator` (turn loop, claim/fence, suspend/resume), `CollaborationStore` (turn order, round/invocation/token budgets, chair-only decisions, replay, hash chain), `buildMeetingRecord` / `renderMeetingRecord`, `ParticipantDirectory`, the registered `specialist_*` Mastra agents with the runtime-owned read-only tool table, the pack loader and capability gates (`handles`, `negotiate`), `checkRepository`, `probeOllama`, `jsonObjectCandidates`.

New adapters (`src/runtime/council/`, `src/integrations/mastra/council/`): `CouncilParticipant` (implements the engine's `Participant`, one bounded Mastra agent call per turn), panel selection, phase schemas and prompts, the call journal, the derived council record, `engineering-council-workflow`, readiness/status, the scripted model, the CLI.

## Safety and bounds

- Specialists hold only `read`-class tools (list/read/search files, git status/diff). The repository root reaches the tools through `RequestContext`, chosen by the runtime from a path inside `AGENTIC_SPECIALIST_ROOTS` (default: this project). Tested: a write tool does not exist for them, `../` and absolute paths are refused.
- Every refusal (pack, panel, model, repository, question, focus paths, credential in the question) happens before any model call and leaves no meeting behind.
- Bounds: exactly 3 seats; 3 rounds; 9 turn reservations and 120k tokens per session (store); per seat 4 model calls and 40k tokens; at most 1 re-ask for a malformed reply; 8 agent steps per call; per-call timeout 240 s and per-turn timeout 600 s live (10 s / 30 s scripted); `readFile` returns at most 3000 bytes.
- A malformed reply after the re-ask, a provider error, a timeout or an exhausted budget ends the meeting `failed` / `budget_exhausted` with the reason. Nothing is invented for the missing turn.
- The record verifies cited evidence: each cited path is checked to exist in the repository, and a turn that used no file tool says its citations were **not read** by that call.
- No Git writes, merges, deploys or paid providers. The proposed decision carries `authority: none` and `humanApproval: pending`.

## Durability

The meeting is durable and resumable: events are in SQLite with the engine's fencing, and `calls.jsonl` is append-only, so per-seat budgets survive a restart. Interrupt a run (Ctrl-C, server restart) and re-run with the same `--meeting-id`: completed turns are not repeated, the interrupted call is recorded as lost and charged. **The Mastra workflow run that wrapped the meeting is not durable**; a server restart loses that run (the CLI reports it presumed lost), not the meeting.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `council: Cannot start the council on http://localhost:4111 ... Is the Mastra server running?` (exit 3) | Start `npm run dev`, or pass `--server http://localhost:<port>`, or use `--in-process`. |
| `REFUSED ... live_not_enabled` | LIVE needs `AGENTIC_COUNCIL_LIVE=1` in the process that runs the council: the **server's** environment for server runs. |
| `model_context_undeclared` / `context window is not declared` | Set `OLLAMA_NUM_CTX` to the model's window (>= 8192). It is refused, never guessed. |
| `model_not_ready: endpoint unreachable` | Ollama is not running: `ollama serve` (or open the Ollama app). |
| `model_not_ready: ... model X is not installed` | `ollama pull <model>` or set `OLLAMA_MODEL` to an installed tag (`ollama list`). |
| `pack_unavailable` / `unknown_specialist` in `status` | The engineering pack under `engineering/` did not load; `npm run engineering -- validate` names the manifest. |
| `not_registered_in_mastra: <id>` | The server did not register that specialist; check the `[specialists]` / `[council]` lines in the server log. |
| Outcome `failed: ... invalid critique after 2 attempt(s)` | The model's reply broke the schema twice; the meeting failed closed by design. Start a new meeting id. |
| Outcome `budget_exhausted` | A limit in the table above was reached; the record says which. |
| Exit 130 / `suspended` | Interrupted; re-run the same `--meeting-id` to resume. |
| First LIVE call slow | Ollama cold-loads the model (about 5 s) and qwen3 thinks before answering; 40-120 s per call is normal on a laptop. |

## Limitations

- SCRIPTED proves wiring and rules only. LIVE quality is that of an 8B local model: in the observed run four of six citing turns cited files without reading them (the record flags each one), and some claims about the code were wrong. Treat the output as a discussion aid, never as review.
- Critique is one linked target per member per round (one message per turn in the engine).
- Council meetings live in `.workdir/council/council.db`, not the scheduler database, so `lead meeting status` and the Control Center do not list them.
- The workflow run is not durable (see Durability); the meeting is.
- Token totals become `UNKNOWN` when a call was lost before reporting usage; they are never shown as 0.
