# Engineering council (issue #54): observed evidence, 2026-10-19

Machine: the operator's Mac, Ollama 0.32.13 with `qwen3:8b-ctx8192`. Mastra dev server on port 4211 (4111 was held by an unrelated server). Records below are copied verbatim from `.workdir/council/<id>/record.md`.

| Record | Mode | Commit | Outcome |
| --- | --- | --- | --- |
| [observed-scripted-record.md](observed-scripted-record.md) | SCRIPTED | e9806d4 | decided (accept, contested) |
| [observed-live-run1-failed-closed.md](observed-live-run1-failed-closed.md) | LIVE | 90876ee | **failed closed**: the chair twice named a non-existent proposal id (it copied a prompt fence hash). This led to members being addressed by specialist id (e9806d4). |
| [observed-live-record.md](observed-live-record.md) | LIVE | e9806d4 | decided (defer, contested); 3 objections; 7 calls, 0 re-asks; ~9 minutes |

The LIVE runs were made before the later audit commit (shared JSON extractor, existing meeting-record renderer, agent ids in the journal). That commit did not change prompts, schemas or the turn flow; a LIVE run on the final head has **not** been made.

## Trace evidence (Mastra observability API, `GET /api/observability/traces/<traceId>`)

SCRIPTED, trace `136b0b5d219a65945e570572d2e028c5` (meeting srv-scripted-1 at commit 90876ee, workflow run 277c6c98-aeb5-49f1-80f1-9086bf52e266): 54 spans; one `workflow_run` root, 3 `workflow_step` (prepare, convene, record), 7 `agent_run` (`council-scripted-architect` proposal/critique/synthesis, `council-scripted-security-reviewer` proposal/critique, `council-scripted-reliability-reviewer` proposal/critique), 3 `tool_call` (`readFile` of three repository files), 7 `model_generation`. Agent spans carry metadata `councilMeetingId`, `specialistId`, `manifestVersion`, `phase`, `round`, `attempt`, `workflowRunId`.

LIVE, trace `5d66fbdaa820098e8aeec4b63422806f` (meeting srv-live-2, workflow run 58145cac-93fe-49b4-a517-840a1f877ef8): 63 spans; 3 `workflow_step`, 7 `agent_run` by the registered agents `specialist-architect` (proposal 115 s, critique 64 s, synthesis 79 s), `specialist-security-reviewer` (123 s, 55 s), `specialist-reliability-reviewer` (56 s, 38 s); 4 `tool_call` (`searchFiles` once, `readFile` three times); 7 `model_generation`, all with model `qwen3:8b-ctx8192`.

## What the LIVE record shows about model quality

The 8B model produced schema-valid proposals, critiques and a synthesis, and a real three-way disagreement. Its reading of the code was shallow: it said the specialist workflow "likely" retries (it does, bounded by the manifest), and four of the six turns that cited files (one proposal, all three critiques) used no file tool in that call; every cited path does exist. The record marks each such turn ("NO file tool was used this turn: the cited files were NOT read by this call"). This is the intended behaviour: the record exposes it instead of presenting the citations as evidence.
