---
name: autonomous-engineering
description: Use the Agentic Engineering runtime to inspect a target repository, prepare bounded engineering objectives, delegate implementation to configured coding workers, and verify results. Use when the user asks for autonomous or delegated software engineering through Agentic Engineering.
---

# Autonomous Engineering

Use the Agentic Engineering runtime as the execution authority. This skill is an agent-facing adapter only: it does not grant permissions, start paid providers, approve plans, weaken sandboxing, or make an unverified result successful.

## Locate the runtime

1. Resolve the runtime checkout from `AGENTIC_ENGINEERING_ROOT` if set.
2. Otherwise ask the operator for the existing Agentic Engineering checkout; do not clone, download, or install it implicitly.
3. Confirm the directory contains `package.json` with `name: "agentic-engineering"`.
4. Check Node.js >=22.13 and installed dependencies. If dependencies are missing, report the exact prerequisite; do not install packages without the operator's authorization.
5. Run commands from the runtime root. Use `npm run lead -- <args>`.

## Intake and repository reconnaissance

1. Identify the target repository and its canonical checkout. Never assume the runtime repository is the target.
2. Read the target's `AGENTS.md`, project instructions, contribution guide, package scripts, and relevant architecture.
3. Inspect Git status, current branch, existing worktrees, recent changes, and relevant tests before editing.
4. Preserve existing user changes. Do not switch branches, reset, stash, clean, or delete worktrees.
5. Convert the request into a bounded objective: outcome, scope, constraints, acceptance criteria, verification commands, risk, dependencies, and explicit non-goals.
6. Prefer existing project tasks and conventions. Do not invent product, authorization, data-sharing, or security policy to satisfy a technical gate.

## Use the runtime

The supported execution path is the runtime's Lead CLI -> scheduler -> executor -> Mastra workflow -> coding runner -> worker -> sandboxed verifier -> review -> integration. Do not create a parallel worker loop or edit task worktrees behind the runtime.

Before planning, inspect runtime status and provider availability:

```sh
npm run lead -- tasks
npm run lead -- status
npm run lead -- providers
```

Prepare an objective/plan using the current CLI contract and project-specific acceptance criteria. Planning is not execution. The runtime currently requires explicit operator actions for submission, provider authorization/budget, lifecycle authorization, review decisions, and integration.

## Authorization and cost gates

- Never infer permission to invoke a cloud provider from an installed CLI, login session, subscription, or environment variable.
- Never make a paid provider call unless the operator explicitly authorizes that provider and its budget for the current task.
- Do not pass secrets to workers or include credentials in prompts, plans, logs, or evidence.
- Do not weaken sandbox, filesystem scope, provider allow-lists, budgets, verification, review, or integration gates.
- Do not push, merge to a protected/default branch, deploy, publish, or mutate production data unless explicitly authorized.
- If the runtime refuses a task, preserve the refusal reason. Do not bypass it with direct shell edits or another worker path.

## Execution and recovery

When the operator has explicitly authorized the required actions:

1. Submit the reviewed plan through the documented Lead CLI.
2. Run only the authorized batch/objective and provider allow-list/budget.
3. Monitor scheduler state and Mastra Studio; do not infer success from worker prose.
4. On runtime failure, inspect the persisted task state and artifacts. Use bounded runtime recovery commands only; do not reset state or recreate work to hide a failure.
5. Continue independent tasks only when their dependencies and scopes are satisfied.

## Verification and handoff

- Runtime verifier PASS is required before a task is reviewable; a worker's claim is not evidence.
- Review is independent of the worker. Reject or escalate when acceptance criteria, scope, or evidence are incomplete.
- Integration is a separate explicit gate. Do not equate APPROVED with DONE.
- Report exact commands, test counts/results, provider/model and known cost telemetry, task states, artifact locations, and unverified checks.
- If a prerequisite, permission, policy decision, or runtime capability is missing, state the smallest concrete blocker and continue independent read-only work.

## Important limitation

Agentic Engineering is experimental and local-first. The current supported sandbox path is macOS-specific. Installing this skill does not install or configure the runtime, providers, Ollama, Mastra Studio, credentials, or OS isolation, and does not certify unattended production use.
