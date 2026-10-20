# Agentic Engineering

**Experimental local-first, evidence-driven autonomous software-engineering runtime.**

A human operator scopes work and approves actions; a model-backed Engineering Lead plans and reviews a task DAG; the persistent scheduler delegates bounded implementation tasks to coding workers. The runtime owns verification, audit and integration—not the models' claims of success.

> **Experimental, not production-ready.** M10.1 safety closure was merged in [PR #44](https://github.com/anvh2/agentic-engineering/pull/44), but this does **not** certify unattended operation on valuable or secret-bearing repositories. No provider call, repository mutation, push or unattended run is authorized merely by installing this repository.

## Architecture

```text
Human operator (scope, budgets, approvals)
  -> Engineering Lead (Claude CLI integration; others under development)
  -> SQLite Scheduler (DAG, atomic claims, leases, fencing, events)
  -> Mastra workflow adapter -> bounded coding runner -> provider worker
  -> isolated Git worktree -> sandboxed verifier
  -> independent review/acceptance -> audited integration
```

Mastra, Ollama, Qwen, Claude and other providers are replaceable adapters, not the source of execution authority. Core packages live in `src/runtime`, `src/lead`, `src/workers` and `src/integrations`. See [runtime architecture](docs/architecture/runtime.md) and [model registry](docs/architecture/model-registry.md) for how agents are bound to models.

## Requirements and limitations

- **macOS** is required for the currently supported `sandbox-exec` path. Linux/Windows are not currently claimed supported.
- **Node.js >=22.13**, npm, Git, and the language toolchain required by a test target.
- Ollama with the configured local model for the default coding worker. Cloud/CLI providers are optional and require explicit authorization and their own credentials/quotas.
- A disposable **secret-free** target Git repository. Sandbox policy is defense-in-depth, not a substitute for OS isolation or backups.
- Scheduler DB is local SQLite under `.workdir/`; model capacity DB is shared on the same machine. Do not put these files on an untested network filesystem.

## Local development quickstart

```sh
git clone https://github.com/anvh2/agentic-engineering.git
cd agentic-engineering
node --version  # >=22.13
npm ci
cp .env.example .env
# Install/start Ollama and provision OLLAMA_MODEL separately before running a worker.
npm run typecheck
npm run dev     # Mastra development server / Studio (typically localhost:4111)
```

Starting the development server does **not** start an autonomous engineering mission. Follow the [OSS local quickstart](docs/operations/oss-quickstart.md) before submitting a bounded task plan, and use a disposable target for first experiments.

**Organization UI:** The customized `/organization` sidebar requires the separately built version-pinned Studio fork; it is **not** bundled automatically by `npm run dev`. See [Studio build and launch](docs/operations/m8.4-studio-organization.md). Its local Gateway is not suitable for exposure on a public interface.

## CLI and checks

```sh
npm run typecheck
npm test                           # may be slow; includes OS-sensitive subprocess tests
npm run lead -- tasks
npm run lead -- status
npm run lead -- plan <plan.json>    # explicit operator decision
npm run lead -- run --batch <id>    # can invoke models and mutate managed worktrees
npm run lead -- cancel <task-id>
npm run lead -- resume
```

See `package.json` for the canonical scripts. At PR #44 final HEAD `4fa9bc6`, the operator reported **1,082/1,082** local regression tests passing (Node v22.23.2, macOS, exit 0); this is historical local evidence, **not** a claim about the current tree or hosted CI. No hosted CI guarantee is implied.

## Safety, source privacy and model costs

- A model's final text never counts as verification; runtime tests and acceptance evidence decide.
- Do not give workers production secrets, credentials or valuable repositories. Cloud model prompts can contain source snippets even when files remain local.
- Store API keys in ignored environment files or an approved secret manager, not in commits, logs or evidence archives. Subscription plans do not imply free API usage.
- No automatic paid calls, pushes or direct modifications of the user's checkout are authorized by default.
- See [SECURITY.md](SECURITY.md) and [OSS release gate](docs/operations/oss-release-checklist.md).

## Contributing and licensing

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and [Apache-2.0](LICENSE). This license applies to repository-owned material unless a file specifies otherwise. The version-pinned Studio fork, upstream code and bundled third-party components retain their own licenses/notices; do not assume this root license supersedes them.

There is not yet a stable publicly supported release, cloud service or SLA.
