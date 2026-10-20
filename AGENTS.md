# AGENTS.md

Rules for AI engineering agents (Claude, Qwen, Codex) working in this repository. Humans: see [README.md](README.md).

## Language policy

- English is the working language of this project: agent output, progress updates, plans, specs, ADRs, reports, handoffs, commit messages and PR descriptions, for every agent and reviewer (Claude, Qwen, Codex, Mastra specialists).
- A template, example or tool prompt that selects another language does not override this. Keep non-English text only where it already exists as source, quoted evidence, localization content or data that must stay unchanged; do not translate existing content unnecessarily.

## Load the `mastra` skill first

Load the `mastra` skill BEFORE any Mastra work. Never rely on cached knowledge; APIs change between versions.

## Boundaries

- One supported execution path: `lead CLI → scheduler → executor → Mastra workflow → coding runner → worker → sandboxed verification → review → integration` ([docs/architecture/runtime.md](docs/architecture/runtime.md)). Do not add a parallel path; extend this one.
- Dependency direction: `src/runtime/**` and `src/workers/**` must not import from `src/integrations/**`; integrations adapt the runtime, never the reverse.
- Mastra is an integration: its code lives in `src/integrations/mastra/`. Register agents, tools, workflows and scorers in `src/integrations/mastra/index.ts`.
- This repository contains no product features (video, image generation, shop code). Product work belongs in the product repository; this runtime only operates on target repositories.
- `scripts/` holds supported CLI entrypoints only. No demos, milestone scripts or one-offs.
- Local runtime state lives in `.workdir/` (gitignored; also `.workdir/projects/<name>` for session projects). Never commit it, never write outside it at runtime.
- Project root is found with `findProjectRoot()` (`src/core/paths.ts`, by `package.json` name). Never assume the checkout directory's name or an absolute path.

## Safety rules (do not weaken)

- The worker proposes; only the runtime verifier can produce PASS.
- Model-generated code runs only through the sandbox (`src/runtime/sandbox`); it fails closed. No opt-out flags.
- Keep: run-once/zombie protection, cancellation, lease + fencing, protected repository paths, verification side-effect detection, `npx --no-install`, SQLite busy handling, integration rollback.
- Never push, never touch `main` or the user's checkout, never call paid APIs, never start autonomous batches unless the current task explicitly allows it.
- Persisted identifiers (`agentic.project/1`, `agentic.checkpoint/1`, table names, `~/.agentic-engineering/model-capacity.db`) change only together with an explicit migration; see docs/architecture/runtime.md#persistence.
- Repository evidence (git, tests) wins over notes and memory. Report test results faithfully, including pre-existing failures.

## Conventions

- TypeScript, ESM, Node ≥ 22.13 running `.ts` directly; imports use explicit `.ts` extensions.
- Unit tests sit next to the code as `*.test.ts`; benchmark fixtures and runner live in `tests/bench/`.
- Use the `dev` and `build` scripts from `package.json`, not `mastra dev` / `mastra build` directly (they pass `--dir src/integrations/mastra`).
- Docs: `README.md` and this file at the root; everything else under `docs/{architecture,operations,plans,audits}`. Do not add stray Markdown beside code.

## Verify before claiming done

```shell
npm run typecheck
npm test
```

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
