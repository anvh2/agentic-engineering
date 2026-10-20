# Engineering council on M12 (TypeScript self-delegation): observed evidence, 2026-10-20

A LIVE council of three read-only Mastra specialists (Architect as chair, Security Reviewer, Reliability Reviewer). It ran on the existing M9/M10 `MeetingCoordinator` / `CollaborationStore` through `engineering-council-workflow`, on the local model. **The proposed decision is advisory (`authority: none`, human approval pending).**

| Fact | Value |
| --- | --- |
| Meeting | `m12-ts-delegation-live-2`; 2026-10-20 13:51:27Z to 14:02:02Z (10 min 35 s) |
| Code | branch `integration/phase0-m11-registry-council` at `7e1adda` (PR #57) |
| Model | `ollama/qwen3:8b-ctx8192` for all 7 calls, on loopback Ollama. The server ran from a worktree with no `.env`, so it held no paid keys and no Mastra platform token |
| Mastra workflow run | `c895fd2e-a5c2-406f-b52a-fc96d29fd0eb` |
| Trace | `95cac200f1a7996601deb3c1b3b513d8`: 58 spans = 1 `workflow_run`, 3 `workflow_step`, 7 `agent_run`, 7 `model_generation`, 9 `model_step`, 9 `model_inference`, 2 `tool_call`, 20 `model_chunk` |
| Outcome | **decided: defer** (decision m7 by the chair on m3), 3 objections outstanding, 0 support |
| Accounting | 7 model calls, 0 re-asks, 0 invalid; tokens in 14 109 / out 9 280; turns 7/9 |
| Integrity | record `5908749837eb9838`, meeting record `f164a573794ea34a`, events through 17 |

Files, verbatim from `.workdir/council/m12-ts-delegation-live-2/`:
- `record.md`: the council record, with positions, objections, synthesis and evidence checks.
- `meeting-record.md`: the M9/M10 engine's own record.
- `calls.jsonl`: one line per model call. It holds reply hashes, never reply text.
- `meeting.json`: the roster and limits. The one absolute repository path is redacted to `<repository>`.
- `trace-spans.json`: the span tree from the observability API, without the `model_chunk` spans.

An earlier attempt, `m12-ts-delegation-live-1` (13:47:20Z), was **refused before any call**. All three seats came back `model_binding_missing` because of the tracing-Proxy defect fixed in `7e1adda`. It left no meeting state.

## Tool usage, as recorded

These counts come from `calls.jsonl` and agree with the trace's 2 `tool_call` spans:

| Turn | Agent | Tools used |
| --- | --- | --- |
| proposal | specialist-architect | none |
| proposal | specialist-security-reviewer | `searchFiles` ×1 |
| proposal | specialist-reliability-reviewer | `searchFiles` ×1 |
| critique | all three | none |
| synthesis | specialist-architect | none |

**No specialist called `readFile`.** Every citation of `delegation.ts` and `language-adapters.ts` is therefore a citation of a path named in the question, not of file contents. The record flags the turns that used no tool at all. Two corrections to the record: the 1 tool call in two of the proposals was a search, not a read; and `src/runtime/sandbox [NOT FOUND]` is a false negative, because that path is a directory and the evidence check only resolves files.

## Engineering Lead response, with evidence (advisory, like the council)

Errors in the discussion:
- All three proposals describe `tsc --noEmit` as "precompiling .ts to JS, then node --test on the output". `--noEmit` emits nothing, and this repository runs `.ts` directly on Node ≥ 22.13 (AGENTS.md). A type check and a test run are two separate commands.
- The reliability reviewer said safety-critical paths are "protected by path whitelists in language-adapters.ts". **That is false.** `language-adapters.ts` has extension ceilings only (`ts` is registered with `enabled: false` and no verification binaries). The only protected-path rule, `isProtectedPath` in `src/workers/tools/repository-tools.ts`, covers `.git`, `node_modules` and `.applypatch-*`. No rule keeps a worker away from `src/runtime/sandbox`, the verifier or the delegation gate.

The chair's action items, answered from the code:
1. *How does delegation.ts gate file types?* `languageOf` → `delegatableLanguage(extensions)` requires every allowed file to share one **enabled** adapter's extensions. `effectivePolicy` clamps a request to that adapter's ceiling and can never widen it. The verification binary must be on the adapter's allow-list, and JS argv must be exactly `npx --no-install jest [--runInBand|--ci] <test files>`. `.ts` is refused today because the adapter is disabled (`src/runtime/execution/delegation.ts`, `language-adapters.ts`).
2. *Validate the path whitelists against the non-delegatable paths.* No such list exists. That is the blocking gap.

Proposed M12 acceptance criteria. These are the Lead's synthesis; human approval is required before any of it is enabled:
- A runtime-owned, non-delegatable source deny-list, enforced in `routeTask`, which refuses before a worktree exists. It covers at least `src/runtime/{scheduler,sandbox,execution,integration,models,council,review,capacity,worktree}`, `src/workers/**`, `src/integrations/mastra/council/**`, `scripts/**`, `.github/**`, `package.json`, `package-lock.json` and `tsconfig.json`. It must also be enforced in the post-attempt mutation check, so an edit outside the allowed file into those paths fails even with the adapter disabled.
- The `ts` adapter stays `enabled: false` until a human approves it. Its verifier argv would be exactly `node --disable-warning=ExperimentalWarning --test <one named *.test.ts>`, validated like the jest argv (normalized repo-relative path, a test file, exists or is hidden, not a symlink). `npx --no-install tsc --noEmit -p .` would be a second, separately validated command.
- Negative tests before any live run: the worker cannot be assigned a deny-listed path, a symlink or a test file; it cannot run whole-suite `node --test` or a glob; it cannot use `--import`/`--require`/`--experimental-*` flags that load other code; it cannot write outside the allowed file; and the sandbox read allow-list is unchanged.
- A benchmark on a TypeScript ladder (like `tests/bench/go-ladder`) with hidden oracles, before the first self-change.

## Inspecting this meeting

The records live in the worktree that ran the server, so run these from the repository root there.

```shell
npm run council -- show m12-ts-delegation-live-2          # council record (Markdown); add --json for the structured record
PORT=4211 AGENTIC_COUNCIL_LIVE=1 OLLAMA_MODEL=qwen3:8b-ctx8192 OLLAMA_NUM_CTX=8192 npm run dev   # Studio + API
open http://localhost:4211/workflows/engineering-council-workflow/graph/c895fd2e-a5c2-406f-b52a-fc96d29fd0eb   # the workflow run
open http://localhost:4211/observability                  # Studio > Observability; filter by trace id 95cac200f1a7996601deb3c1b3b513d8
curl -s http://localhost:4211/api/observability/traces/95cac200f1a7996601deb3c1b3b513d8 | jq '.spans | group_by(.spanType) | map({type: .[0].spanType, n: length})'
curl -s 'http://localhost:4211/council/v1/status?probe=1' | jq .live
```

The trace is stored in the server's local observability store (DuckDB, created by `mastra dev` under `.mastra/`). It is only visible from a server started in the same checkout.
