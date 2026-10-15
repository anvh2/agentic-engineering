# Operating the engineering pack

Architecture and trust model: [docs/architecture/engineering-pack.md](../architecture/engineering-pack.md).
Known gaps and what is verified: [findings register](../audits/2026-10-pr53-ecc-integration/findings-register.md).

## Files and state

| Path | What | Written by |
| --- | --- | --- |
| `engineering/skills/*.json`, `engineering/agents/*.json` | the pack (committed) | developers, through review |
| `.workdir/engineering/knowledge.db` | promoted skills and lessons, audit events, used grant nonces | `engineering promote` / `revoke` |
| `.workdir/engineering/keyring.json` | **public** keys the runtime trusts (array of `{keyId, principalId, publicKeyPem, roles}`) | the operator |

`.workdir/` is gitignored runtime state. Private keys must not live in this repository or anywhere the agents can read.

## Day to day

```shell
npm run engineering -- status                 # pack health, drift, provider readiness, issues; exit 1 only on an error
npm run engineering -- status --json          # machine-readable (schema engineering-status/v1)
npm run engineering -- agents                 # specialists, tools, how many of their skills are active, fit for the configured model
npm run engineering -- skills                 # state of every skill: active, not-promoted or stale
npm run engineering -- validate               # exit 1 unless the pack loads and every declared scenario passes
npm run engineering -- drift --strict         # exit 1 on stale (edited after promotion) or orphaned (promoted, no manifest) skills
npm run engineering -- pin --language go --type implement --text "<task description>"   # prints the knowledge pin for a task contract
npm run engineering -- render claude-code security-reviewer   # prints a subagent definition; installs nothing
```

`status --probe-ollama` additionally contacts the configured Ollama endpoint, but only if it is a loopback address. Without it nothing is contacted.

Studio and HTTP: `npm run dev` serves `GET /engineering/v1/status` (same report) on the existing Mastra server with its normal authentication and the `observability:read` permission.

## Promoting a skill (operator procedure)

A skill has no effect until a trusted promoter key signs a grant for its exact content.

1. Provision a key pair on a machine and account the agents cannot read, for example
   `openssl genpkey -algorithm ed25519 -out promoter.pem && openssl pkey -in promoter.pem -pubout -out promoter.pub`.
2. Put the public half in `.workdir/engineering/keyring.json` with `roles: ["promoter"]` (add `evidence-signer`, `reviewer` or `verifier` keys the same way when you use those flows).
3. Review the manifest diff. `npm run engineering -- validate` must pass.
4. Sign a grant for it (run this yourself, outside the agents' reach; it prints a JSON statement):

   ```shell
   node --disable-warning=ExperimentalWarning --input-type=module -e '
   import { readFileSync } from "node:fs"; import { randomBytes } from "node:crypto";
   import { signStatement } from "./src/runtime/knowledge/trust.ts";
   import { PROMOTION_DOMAIN } from "./src/runtime/knowledge/engineering-knowledge-store.ts";
   import { loadPackRegistry } from "./src/runtime/knowledge/packs/loader.ts";
   import { promotedDigestOf } from "./src/runtime/knowledge/packs/skills.ts";
   const skill = loadPackRegistry(process.cwd()).skillById.get(process.argv[1]);
   console.log(JSON.stringify(signStatement(readFileSync(process.argv[2], "utf8"), process.argv[3], PROMOTION_DOMAIN,
     { action: "promote", entryId: skill.id, digest: promotedDigestOf(skill), projectId: null, nonce: randomBytes(12).toString("hex"), expiresAt: Date.now() + 600000 })));
   ' go-testing /secure/path/promoter.pem my-promoter-key > grant.json
   ```
5. `npm run engineering -- promote go-testing --grant grant.json`. A grant is single use and expires; replaying it fails.
6. A changed manifest has a new revision. Promote it the same way; the CLI supersedes the active revision atomically.
7. To withdraw a skill: sign a grant with `action: "revoke"` and the digest of the active entry, then `npm run engineering -- revoke go-testing --grant grant.json`. Revocation is one way; to bring back earlier content, promote it again as a new revision.

New tasks stop seeing a revoked or superseded skill immediately: the coding workflow reads the store on every run that pins knowledge, and a task pinned to the old revision is refused and stays with Claude with a reason.

## Pinning skills into a task (Lead)

`npm run engineering -- pin ...` prints `{"knowledge": {"ids": [...], "selectionDigest": "..."}}` for the task text. Put that object under `contract.knowledge`.
The pin adds guidance text only; it never changes allowed files, verifier commands, tools or approvals. The routing gate, the runner and the reviewer each re-resolve it from the store.

## Running a specialist

In Mastra Studio: **Workflows -> specialist-review-workflow -> Run**, input:

```json
{
  "specialistId": "go-reviewer",
  "repository": "/absolute/path/inside/a/configured/root",
  "taskId": "T-123",
  "language": "go",
  "taskType": "review",
  "objective": "Review the lease renewal change for races and error handling.",
  "focusPaths": ["internal/lease/renew.go"]
}
```

- The repository must lie inside `AGENTIC_SPECIALIST_ROOTS` (path-delimited), default the project root. Otherwise the run ends `REFUSED` before any model call.
- The agents also appear under **Agents** as `specialist-<id>`. Use the workflow rather than chatting with them: only the workflow supplies the repository, a timeout, validation and trace metadata. Without the workflow's request context their tools return nothing.
- Statuses: `REPORTED`, `INVALID_OUTPUT`, `REFUSED`, `PROVIDER_ERROR`, `TIMEOUT`, `CANCELED`. The result is always `advisory`. There is no fallback model: a provider error is the end of the run.
- Model: `OLLAMA_BASE_URL`, `OLLAMA_MODEL` (default `qwen3:8b`). Declare the model's context with `OLLAMA_NUM_CTX`. Specialists need at least 8192; with a smaller declared value they are refused with a reason rather than run with a truncated prompt. If it is not declared the context is unknown and not guessed.
- Traces: each model run carries `workflowRunId`, `specialistId`, `taskId`, `reviewId` and `manifestVersion`, and the agent span is a child of the workflow span.
- Signed findings need a runtime-held reviewer key (`findingSigner` dependency). Without one the report is returned unsigned and cannot enter review consensus.

## Reading the status report

| Issue code | Meaning | Action |
| --- | --- | --- |
| `pack_unloaded` (error) | a manifest is invalid; the message names the file | fix the manifest; `validate` shows the same |
| `skill_scenarios_failing` (error) | a declared scenario no longer behaves as declared | fix keywords or the scenario |
| `no_promoted_skills` (warning) | nothing promoted: workers and specialists run without guidance | expected until an operator promotes skills |
| `promoted_skill_stale` (warning) | a manifest changed after promotion; it is not selected | review and promote the new revision, or revert |
| `promoted_skill_orphaned` (warning) | promoted skill with no manifest | revoke it |
| `agent_unsupported_on_configured_model` (warning) | declared context is below the agent's minimum | raise the model context or accept that the agent is refused |
| `skill_declining` (warning) | verified acceptance fell for a skill revision | consider revoking or rolling back (a recommendation, never an action) |

## Smoke tests: DEFERRED, not run

The checks below require live services and were intentionally not run during implementation. They are the final-validation checklist. Each must be recorded with the commit SHA it ran against.

1. `npm run dev`; open Studio; confirm 20 `specialist-*` agents under Agents and the `specialist-review-workflow` and `coding-task-workflow` workflows.
2. `curl -s localhost:4111/engineering/v1/status | jq .pack` returns `loaded: true`.
3. Run `specialist-review-workflow` for `go-reviewer` against a disposable repository with a local Ollama model; confirm the trace shows the workflow span with the agent span below it and the tool calls; confirm a repository outside the configured roots is refused.
4. Provision a throwaway keyring, promote `go-engineering`, run a scheduler task with `engineering pin` output in its contract; confirm the worker prompt contains the skill, the reviewer recomputes the digest, and revoking the skill refuses the next run.
5. End to end: scheduler -> Mastra workflow -> worker -> sandboxed verifier -> independent review on a disposable fixture.
6. Real-provider benchmark runs only with explicit cost authorization (see the benchmark report for what is and is not measured).

## Limits to keep in mind

- Selection is keyword-based over a short task text. It is deterministic and cheap, and it can miss a relevant skill; `pin` shows what was and was not selected and why.
- `repository-tools` refuses well-known credential files. It does not detect a secret pasted into an ordinary file.
- Reports from a small local model can be wrong. They are findings to verify, and HIGH or CRITICAL ones cannot clear review without an independent signed verification.
- TypeScript delegation is disabled; Ruby and Rust are review-only.
