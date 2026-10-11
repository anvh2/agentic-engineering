# OSS local quickstart (experimental)

This guide supports **local evaluation**, not unattended production execution.

## 1. Prepare a macOS host

Requirements: macOS with `sandbox-exec`, Node.js >=22.13, npm, Git, Ollama and the configured model, plus the target repository's toolchain.

```sh
node --version
npm --version
git --version
command -v sandbox-exec
npm ci
cp .env.example .env
```

Edit local `.env` with the model name and Ollama address. You do not need a cloud API key to inspect the local code. Provision Ollama separately; **never paste secrets into GitHub issues or evidence**.

## 2. Verify prerequisites

```sh
npm run typecheck
```

The full test script `npm test` includes slow and platform-sensitive subprocess/integration tests; review its prerequisites and budget before running it. This guide does not claim it passes in every environment.

## 3. Start Mastra

```sh
npm run dev
```

The default development Studio is typically at `http://127.0.0.1:4111`. Do not publicly bind the service. Starting the development server does not by itself submit or run any objectives.

The **custom Organization sidebar** comes from a separate pinned Studio build. See [pinned Studio operations](m8.4-studio-organization.md). Do not interrupt an already running server or overwrite its scheduler database to install the UI.

## 4. Read before running work

```sh
npm run lead -- tasks
npm run lead -- status
```

Review the [runtime architecture](../architecture/runtime.md), choose a disposable secret-free target Git repository and prepare a bounded plan with acceptance criteria. Only with operator-approved model/provider usage and budget:

```sh
npm run lead -- plan /absolute/path/to/plan.json
npm run lead -- run --batch YOUR_BATCH_ID
```

Those commands are examples and require a valid plan; no prebuilt universal fixture is promised. Execution can invoke models and mutate managed worktrees.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Node syntax or engine error | `node --version`, shell PATH and Node >=22.13 |
| Missing sandbox | macOS, `command -v sandbox-exec`; do not bypass isolation |
| Ollama unreachable | Ollama service, model installed, `OLLAMA_BASE_URL` / `OLLAMA_MODEL` |
| Mastra connection failure | Server log and loopback port 4111 |
| Empty task list | No plan submitted, or wrong `AGENTIC_SCHED_DB` |
| Organization reports UNKNOWN | Data/telemetry may be unavailable; UNKNOWN is not zero or PASS |

There is currently no supported hosted installer, remote machine access, managed credits, production cloud control plane or Linux/Windows sandbox guarantee.
