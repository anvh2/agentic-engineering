# Portable specialist agents and skills (ECC-derived)

This integration registers **16 read-only specialist Mastra agents** and defines **40 portable skill metadata entries**. Source inspiration: `affaan-m/ECC/agents` and `affaan-m/ECC/skills`; summaries are original and do not copy or execute arbitrary ECC prompts or hooks.

## Architecture

- `src/runtime/knowledge/engineering-specialists.ts`: harness-neutral agent profile (ID, name, purpose, skill references, original ECC source path, read-only mode).
- `src/runtime/knowledge/engineering-skills.ts`: harness-neutral skill metadata (ID, category, purpose, activation trigger, attribution). **Skill metadata is not a full imported SKILL.md and does not prove measured benefit.**
- `src/integrations/mastra/specialist-agents.ts`: Mastra adapter maps every profile to `@mastra/core/agent.Agent`; stable `specialist-<id>` identities and explicit read-only tools.
- `src/integrations/mastra/index.ts`: registers agents with Mastra so they are discoverable in Mastra Studio under Agents. Existing `codingWorkerGo`/`codingWorkerJs` stay unchanged.

## Operating in Mastra Studio

Run `npm run dev`, open the Mastra Studio interface and navigate to Agents. Profiles appear as `Code Explorer`, `Specification Miner`, `Security Reviewer`, etc. The registration uses the configured local Ollama endpoint (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`); the Studio can enumerate agents without successful inference, but invoking them requires a running compatible model. Their read-only tool calls should be visible in Studio observability when instrumentation is enabled.

**Important distinction:** registration does NOT schedule an agent for every task, automatically invoke specialist reviews, register durable lifecycle execution, or modify the approval/verifier. That needs explicit scheduler routing and evaluation evidence.

## Migration and extension

Implement `SpecialistDefinition` rendering for another provider/harness rather than importing Mastra `Agent` into core runtime. Add a portable definition, reference curated skill IDs, validate its tool boundaries, and supply a harness-specific adapter. Do not turn a profile declaration into an authorization grant.

## Safety limits

- Specialist tools: `listFiles`, `readFile`, `searchFiles`, `gitDiff`, `gitStatus`. No edit, execution, deploy, approval or new tool permissions.
- Role prompts are advisory and cannot turn an LLM answer into runtime PASS.
- This is not an independent external ECC re-test. Local tests, GitHub CI and Mastra Studio smoke are required before declaring functionality validated.
- Avoid loading all 40 skills into every agent prompt: each specialist receives only references for its explicit skills.
