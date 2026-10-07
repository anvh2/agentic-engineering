# Engineering Lead -> local Qwen worker

```
Engineering Lead (Claude)
  -> DelegationRequest { contract: CodingTask, assessment, repository }
  -> Mastra workflow `coding-task-workflow`          (orchestration + Studio visibility)
       prepare-coding-task       validate contract, deterministic routing gate
       run-qwen-worker-harness   existing runner (src/mastra/workflows/coding-task-runner.ts): ONE source of truth
       finalize-result           PASS | ESCALATED_TO_CLAUDE | RUNTIME_FAILURE | KEPT_BY_CLAUDE
```

Run it: `npm run dev` (Studio at http://localhost:4111), then
`npm run lead:delegate -- <request.json> --repo <path>` (add `--dry-run` for the gate only; no server, no model).

## Eligibility (src/mastra/lead/delegation.ts, `routeTask`)
Delegated only if ALL hold, otherwise the task stays with Claude and the worker is never invoked:
assessment is small / low risk / no ambiguity; 1 allowed file (`.go`); never a test file; acceptance criteria and
constraints present (constraints must say tests are immutable); verification binary in {go, gofmt}; context files exist;
git work tree with the allowed files clean. Max 3 coding attempts; runtime failures get one separate retry.

## Outcomes
- `PASS`: harness verifier passed on the exact final state. Change is left UNCOMMITTED for the Lead to review.
- `ESCALATED_TO_CLAUDE`: 3 coding attempts exhausted, or a forbidden mutation. Tree restored; `escalation.json` has the evidence.
- `RUNTIME_FAILURE`: Ollama/model unavailable after its one bounded retry. Not a coding failure; not auto-escalated.
- `KEPT_BY_CLAUDE`: refused by the gate.

## What Mastra Studio shows (verified against the running server)
- Workflows -> `coding-task-workflow`: the three-step graph; every run in the Runs list with per-step status, input and output
  (route + reasons, the harness result, the final report).
- Observability: one trace per run, nested `workflow run > workflow step > agent run coding-worker-go > llm qwen3 > model step >
  tool call` (e.g. `writeFile`, `runGoFmt`), with timings.
- Run state: `phase / attempt / detail / taskId`, persisted at STEP BOUNDARIES (preparing ... passed/escalated/...).

## What Studio cannot show
- Intra-step phases (worker_running / verifying / retrying) are emitted as `coding-phase` events on the workflow stream and are NOT
  persisted mid-step; polling a run mid-flight shows only the last step-boundary state plus the active step.
- The harness's own work (file-hash mutation checks, gofmt, `go test`) is not a Mastra span; coding-attempt boundaries and coding/runtime retries are not
  Studio objects. The complete record is `<artifactDir>/trace.jsonl` (+ attempts.json, contract.json, final.diff, result.json),
  under `.workdir/lead-delegations/<taskId>-<timestamp>/` (override with HARNESS_ARTIFACT_ROOT).
- No raw chain-of-thought is recorded or used.
