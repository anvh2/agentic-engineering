# Model registry and resolver

Status: implemented for Mastra coding workers and specialists. Implements the model/agent split from [ADR: Separate Agent Identity from Model and Execution Roles](../engineering/adr-agent-model-role-boundaries.md).

An agent (`agentId`, role, instructions, tools, skills) is independent of the model that runs it. Which model an agent uses is **runtime configuration**, resolved per agent by `src/runtime/models`, never named in an agent manifest.

```text
agent definition ──▶ ModelResolver.resolve({ agentId, role, requires }) ──▶ { binding, model, capabilities }
                          ▲                                                   │            │
              ModelRegistry (providers, models)                  agentId/providerId/    Mastra Agent
              + policy (role defaults, per-agent assignments)    modelId in traces      `model:` config
```

## Terms

| Term | Meaning |
| --- | --- |
| `agentId` | Stable identity of an agent, for example `specialist-security-reviewer` or `coding-worker-go`. Never derived from a model name. |
| `role` | `coding-worker` or `specialist`. Authorization for models is granted per role (and optionally per agent). |
| `providerId` | An OpenAI-compatible endpoint plus its billing class and credential variable, for example `ollama`. |
| `modelId` | A model served by a provider, for example `qwen3:8b`. A model is identified by the pair `(providerId, modelId)`. |
| binding | `{ agentId, role, providerId, modelId }`. It contains no credential and is what traces and results carry. |

## What the resolver enforces

`ModelResolver.resolve` picks a candidate, then checks it. It never substitutes another model. Candidate order is the model assigned to that exact `agentId`, otherwise the role default.

| Code | Refused when |
| --- | --- |
| `unknown_provider` / `unknown_model` | The assigned model or its provider is not registered. |
| `unauthorized_model` | The model's `roles` do not include the agent's role, or its `agents` allow-list (when present) excludes the agent. |
| `provider_unavailable` / `model_unavailable` | The configured availability is `unavailable`. The reason text is kept. |
| `capability_unsupported` | The agent requires `toolCalling` or `structuredOutput` and the model does not declare it. |
| `credential_missing` | The provider's credential variable is unset and the provider has no local placeholder. |

Construction rules (`ModelConfigError`, thrown when the resolver is built): every role default must exist, and **a default must be on a `local-free` provider**. A metered or subscription provider can only be used when an operator assigns it to a named agent. The policy is copied at construction, so it cannot be changed afterwards.

Declaring a requirement can only narrow which models are acceptable. It never grants one, and it never grants tools: tools come from the host-owned specialist table and the manifest's read-only list, regardless of model.

## Default configuration (unchanged behavior)

With no configuration the registry holds one provider and one model, built from the same variables as before:

| Variable | Default | Used for |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Provider URL (`/v1` is appended) |
| `OLLAMA_MODEL` | `qwen3:8b` | The default model for both roles |
| `OLLAMA_API_KEY` | placeholder `ollama` | Key sent to the endpoint |
| `OLLAMA_NUM_CTX` | undeclared | Declared context window; never guessed |

Both coding workers (`coding-worker-go`, `coding-worker-js`) and every specialist resolve to this model. The model configuration handed to Mastra is identical to the previous hard-coded object.

## Configuring other models

Point `AGENTIC_MODEL_CONFIG` at a JSON file. It **extends** the default; it cannot replace the built-in `ollama` provider, and a duplicate id is an error. A missing or invalid file stops startup (or registers no specialists); it is never ignored in favour of the default.

```json
{
  "schema": "agentic.model-config/1",
  "providers": [
    { "providerId": "lmstudio", "kind": "local", "url": "http://localhost:1234/v1", "billing": "local-free",
      "credential": { "env": "LMSTUDIO_API_KEY", "placeholder": "lm-studio" } }
  ],
  "models": [
    { "providerId": "lmstudio", "modelId": "qwen3-coder",
      "capabilities": { "toolCalling": true, "structuredOutput": true, "contextTokens": 32768 },
      "roles": ["specialist"] }
  ],
  "assignments": [
    { "agentId": "specialist-security-reviewer", "providerId": "lmstudio", "modelId": "qwen3-coder" }
  ]
}
```

Rules checked when the file is read: strict schema (unknown keys are rejected), `http(s)` URLs with no embedded credentials, cloud providers must use `https` and may not be billed `local-free`, only local providers may declare a placeholder, and the file is scanned for credential-shaped strings. **A key never appears in the file; the provider names the environment variable that holds it.** Availability and capabilities are what the operator declares; they are not measured.

To move one specialist to another compatible model, add the model and one `assignments` entry. Its id, instructions, skills and tools do not change.

## Execution metadata

- Mastra agents are built with `bindAgent(agent, binding)`; `bindingOf(agent)` returns it, including for agents fetched from `mastra.getAgent`.
- `specialistReviewWorkflow` carries `agentId`, `agentRole`, `providerId`, `modelId` as separate trace-metadata keys, and returns `model: { agentId, role, providerId, modelId }` in its result. `model` is `null` only when no model could be resolved; a refusal after resolution (for example a too-small context window) still names the model that was considered.
- The coding workflow emits a `model_bound` event into `trace.jsonl` before the first model call and returns `model` in its result.
- If an agent registered at startup is bound to a different model than the one authorized for a run, the specialist run is refused with `model_binding_mismatch` before any call.

## Guidance for code that builds on this

- Resolve, do not read `OLLAMA_*`. Use `resolveSpecialistModel(manifest)` or `modelResolverFromEnv().resolve(...)`, and catch `ModelResolutionError` (stable `code`) and `ModelConfigError`.
- `registerSpecialists()` returns `refused: { id, code, reason }[]` beside `error`. Use both for a health or status view; a refused specialist is absent from `agents` and never substituted.
- Do not log `ResolvedModel.model`; it holds the credential. Log `binding`.
- A council or any new workflow should call specialists through `specialistReviewWorkflow`, or call `resolveSpecialistModel` itself and keep the binding in its record.

## Limits

- **Availability is configured, not probed.** `probeOllama` and `engineering status --probe-ollama` still do the live Ollama check. The resolver does not contact any endpoint.
- **Only Ollama-provider models can run today.** Specialists are gated by the manifest `providers` list (`ollama`, `claude`, `codex`) and by `negotiate`, whose Mastra harness only wires `ollama`. The `ollama` worker provider (capacity permit, probe) is Ollama-specific, so it refuses an agent bound to another provider. A model on another provider is therefore refused as `unsupported` (specialists) or at provider creation (coding workers), never run under a wrong label. Lifting this needs a manifest schema change and a worker-provider entry, which are separate decisions.
- **Switching models is not evidence of quality.** Capabilities are declared. A new model for a specialist still needs its own benchmark evidence, as the ADR requires.
- **`codex` and `gemini` worker providers** are external CLIs that choose their own model. They are not routed through this registry.
- The meeting transport (`lead meeting`) takes explicit `provider:model` participants and is unchanged.
- No credential reaches a binding or trace, but the resolved `model` object holds it in memory by design, because Mastra needs it.
